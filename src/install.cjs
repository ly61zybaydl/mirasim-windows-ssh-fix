"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");
const { FuseV1Options, getCurrentFuseWire } = require("@electron/fuses");
const { inspectPackage, resolveInstallation } = require("./detect.cjs");
const { PATCH_MARKER, SUPPORTED_VERSIONS, patchMainSource, verifyPatchedSource } = require("./patch-main.cjs");
const { asarHeaderHash, buildExeWithUpdatedIntegrity, readExeIntegrity } = require("./pe-integrity.cjs");
const { assertPathInside, normalizePathForComparison, sha256File, writeJsonAtomic } = require("./util.cjs");

const TOOL_VERSION = require("../package.json").version;
const TOOL_ROOT = path.resolve(__dirname, "..");
const ASSET_SOURCE = path.join(TOOL_ROOT, "assets", "linux-compat");
const WINDOWS_ASKPASS_SOURCE = path.join(TOOL_ROOT, "assets", "windows-askpass");
const REQUIRED_ASSET_FILES = new Set([
  "node-v22.23.1-linux-x64-glibc-217.tar.xz",
  "pty-node-v127-glibc217.node",
  "install-legacy-runtime.sh",
  "THIRD_PARTY_NOTICES.txt",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function backupRoot() {
  if (process.env.MIRASIM_SSH_FIX_DATA_DIR) return path.resolve(process.env.MIRASIM_SSH_FIX_DATA_DIR);
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "MirasimRemoteSshPatcher");
}

function installId(installDirectory) {
  return crypto.createHash("sha256").update(normalizePathForComparison(installDirectory)).digest("hex").slice(0, 20);
}

function statePath(installDirectory) {
  return path.join(backupRoot(), "state", `${installId(installDirectory)}.json`);
}

function installLockPath(installDirectory) {
  return path.join(backupRoot(), "locks", `${installId(installDirectory)}.lock`);
}

function acquireInstallLockGate(lockPath) {
  const gatePath = `${lockPath}.gate`;
  let descriptor;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      descriptor = fs.openSync(gatePath, "wx");
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      fs.fsyncSync(descriptor);
      return () => {
        try { fs.closeSync(descriptor); } finally { fs.rmSync(gatePath, { force: true }); }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
        descriptor = undefined;
        try { fs.rmSync(gatePath, { force: true }); } catch {}
        throw error;
      }
      if (error.code !== "EEXIST") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error(`The patch lock coordination gate is busy or stale (${gatePath}). Ensure no patcher is running before removing that gate file.`);
}

function acquireInstallLock(installDirectory) {
  const filePath = installLockPath(installDirectory);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const token = crypto.randomUUID();
  let descriptor;
  const tryOpen = () => {
    descriptor = fs.openSync(filePath, "wx");
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString(), installDirectory })}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } catch (error) {
      try { fs.closeSync(descriptor); } catch {}
      descriptor = undefined;
      try { fs.rmSync(filePath, { force: true }); } catch {}
      throw error;
    }
  };
  const releaseAcquisitionGate = acquireInstallLockGate(filePath);
  try {
    try {
      tryOpen();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (Number.isInteger(existing.pid) && existing.pid > 0) {
          try {
            process.kill(existing.pid, 0);
          } catch (processError) {
            stale = processError.code === "ESRCH";
          }
        }
      } catch {
        // A malformed lock may belong to a process that is still starting. Fail closed.
      }
      if (!stale) throw new Error(`Another patch or restore operation is active for this Mirasim installation (${filePath})`);
      fs.rmSync(filePath, { force: true });
      tryOpen();
    }
  } finally {
    releaseAcquisitionGate();
  }
  return () => {
    const releaseRemovalGate = acquireInstallLockGate(filePath);
    try {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    } finally {
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (existing.token === token) fs.rmSync(filePath, { force: true });
      } catch {
        // Never delete a lock that cannot be proven to belong to this process.
      }
      releaseRemovalGate();
    }
  };
}

function checkedAssetRelativePath(relative) {
  if (relative === "windows-askpass.exe") return relative;
  if (typeof relative !== "string" || !/^linux-compat\/[A-Za-z0-9._-]+$/.test(relative)) {
    throw new Error(`Invalid compatibility asset path in patch state: ${String(relative)}`);
  }
  return relative.split("/").join(path.sep);
}

function validateHash(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} is not a SHA-256 value`);
  return value.toLowerCase();
}

function validatePatchState(state, app) {
  if (!state || state.schemaVersion !== 1) throw new Error("The patch state is missing or uses an unsupported schema");
  if (normalizePathForComparison(state.installDirectory) !== normalizePathForComparison(app.installDirectory)) {
    throw new Error("The patch state belongs to a different Mirasim installation");
  }
  if (state.mirasimVersion !== app.packageJson.version) throw new Error("The patch state belongs to a different Mirasim version");
  if (state.lastTransactionId !== undefined && !/^[0-9a-f]{32}$/.test(state.lastTransactionId)) {
    throw new Error("The patch state contains an invalid transaction identifier");
  }
  const originalAsarHash = validateHash(state.original?.asarHash, "Original ASAR hash");
  const originalExeHash = validateHash(state.original?.exeHash, "Original EXE hash");
  const patchedAsarHash = validateHash(state.patched?.asarHash, "Patched ASAR hash");
  const patchedExeHash = validateHash(state.patched?.exeHash, "Patched EXE hash");
  const expectedBackupDirectory = path.join(
    backupRoot(),
    "backups",
    installId(app.installDirectory),
    state.mirasimVersion,
    `${originalAsarHash}-${originalExeHash}`,
  );
  const expectedAsarPath = path.join(expectedBackupDirectory, "app.asar");
  const expectedExePath = path.join(expectedBackupDirectory, "Mirasim.exe");
  assertPathInside(backupRoot(), expectedAsarPath, "ASAR backup");
  assertPathInside(backupRoot(), expectedExePath, "EXE backup");
  if (normalizePathForComparison(state.original.asarPath) !== normalizePathForComparison(expectedAsarPath) ||
      normalizePathForComparison(state.original.exePath) !== normalizePathForComparison(expectedExePath)) {
    throw new Error("The patch state contains an unexpected backup path");
  }
  const assetHashes = {};
  for (const [relative, hash] of Object.entries(state.assetHashes || {})) {
    checkedAssetRelativePath(relative);
    assetHashes[relative] = validateHash(hash, `Asset hash for ${relative}`);
  }
  if (Object.keys(assetHashes).length === 0) throw new Error("The patch state contains no compatibility asset hashes");
  return {
    ...state,
    original: { ...state.original, asarHash: originalAsarHash, exeHash: originalExeHash, asarPath: expectedAsarPath, exePath: expectedExePath },
    patched: { ...state.patched, asarHash: patchedAsarHash, exeHash: patchedExeHash },
    assetHashes,
  };
}

function transactionJournalPath(installDirectory) {
  return path.join(backupRoot(), "transactions", `${installId(installDirectory)}.json`);
}

function mutationPaths(installDirectory, transactionId) {
  if (!/^[0-9a-f]{32}$/.test(transactionId)) throw new Error("Invalid patch transaction identifier");
  const resourcesDirectory = path.join(installDirectory, "resources");
  const asarPath = path.join(resourcesDirectory, "app.asar");
  const exePath = path.join(installDirectory, "Mirasim.exe");
  return {
    asarPath,
    exePath,
    finalAssets: path.join(resourcesDirectory, "mirasim-ssh-fix"),
    stagedAsar: `${asarPath}.mirasim-ssh-fix.${transactionId}.new`,
    stagedExe: `${exePath}.mirasim-ssh-fix.${transactionId}.new`,
    rollbackAsar: `${asarPath}.mirasim-ssh-fix.${transactionId}.rollback`,
    rollbackExe: `${exePath}.mirasim-ssh-fix.${transactionId}.rollback`,
    stagedAssets: path.join(resourcesDirectory, `.mirasim-ssh-fix.${transactionId}.new`),
    rollbackAssets: path.join(resourcesDirectory, `.mirasim-ssh-fix.${transactionId}.rollback`),
  };
}

function normalizedAssetHashes(value, label) {
  const result = {};
  if (value == null) return result;
  for (const [relative, hash] of Object.entries(value)) {
    checkedAssetRelativePath(relative);
    result[relative] = validateHash(hash, `${label} hash for ${relative}`);
  }
  return result;
}

function writeTransactionJournal(installDirectory, journal) {
  writeJsonAtomic(transactionJournalPath(installDirectory), {
    schemaVersion: 1,
    installDirectory,
    updatedAt: new Date().toISOString(),
    ...journal,
  });
}

function removeVerifiedFile(filePath, allowedHashes, label) {
  if (!fs.existsSync(filePath)) return;
  const actual = sha256File(filePath);
  if (!allowedHashes.includes(actual)) throw new Error(`${label} has an unexpected SHA-256 and was preserved: ${filePath}`);
  fs.rmSync(filePath, { force: true });
}

function moveToRollbackVerified(livePath, rollbackPath, expectedHash, label) {
  fs.renameSync(livePath, rollbackPath);
  let actualHash;
  try {
    actualHash = sha256File(rollbackPath);
  } catch (error) {
    if (!fs.existsSync(livePath)) {
      try { fs.renameSync(rollbackPath, livePath); } catch {}
    }
    throw new Error(`${label} could not be verified after its rollback move: ${error.message}`);
  }
  if (actualHash !== expectedHash) {
    if (!fs.existsSync(livePath)) fs.renameSync(rollbackPath, livePath);
    throw new Error(`${label} changed during the final replacement window. The concurrently changed file was preserved.`);
  }
}

function publishStagedFileNoClobber(stagedPath, livePath, label) {
  try {
    fs.linkSync(stagedPath, livePath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`${label} was recreated by another process during replacement and was preserved`);
    }
    throw error;
  }
  fs.unlinkSync(stagedPath);
}

function moveAssetTreeToRollbackVerified(livePath, rollbackPath, expectedHashes, label) {
  fs.renameSync(livePath, rollbackPath);
  if (!expectedHashes) return;
  try {
    verifyInstalledAssetTree(rollbackPath, expectedHashes);
  } catch (error) {
    if (!fs.existsSync(livePath)) {
      try { fs.renameSync(rollbackPath, livePath); } catch {}
    }
    throw new Error(`${label} changed during the final replacement window and was preserved: ${error.message}`);
  }
}

function removeOwnedAssetTree(root, assetHashes, label) {
  if (!fs.existsSync(root)) return;
  const normalizedRoot = normalizePathForComparison(root);
  const expectedFiles = new Map();
  const expectedDirectories = new Set([normalizedRoot]);
  for (const [relative, hash] of Object.entries(assetHashes || {})) {
    const safeRelative = checkedAssetRelativePath(relative);
    const target = path.join(root, safeRelative);
    assertPathInside(root, target, label);
    expectedFiles.set(normalizePathForComparison(target), validateHash(hash, `${label} hash for ${relative}`));
    let parent = path.dirname(target);
    while (normalizePathForComparison(parent) !== normalizedRoot) {
      expectedDirectories.add(normalizePathForComparison(parent));
      parent = path.dirname(parent);
    }
  }
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const entryPath = path.join(entry.parentPath || entry.path, entry.name);
    const normalized = normalizePathForComparison(entryPath);
    if (entry.isFile()) {
      const expected = expectedFiles.get(normalized);
      if (!expected || sha256File(entryPath) !== expected) {
        throw new Error(`${label} contains an unowned or modified file and was preserved: ${entryPath}`);
      }
    } else if (!entry.isDirectory() || !expectedDirectories.has(normalized)) {
      throw new Error(`${label} contains an unowned entry and was preserved: ${entryPath}`);
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function recoverJournalFile(livePath, rollbackPath, stagedPath, originalHash, replacementHash, committed, label) {
  if (committed) {
    if (!fs.existsSync(livePath) || sha256File(livePath) !== replacementHash) {
      throw new Error(`Committed ${label} transaction does not match its replacement hash`);
    }
    removeVerifiedFile(rollbackPath, [originalHash], `${label} rollback`);
  } else if (fs.existsSync(rollbackPath)) {
    if (sha256File(rollbackPath) !== originalHash) throw new Error(`${label} rollback failed SHA-256 verification`);
    if (fs.existsSync(livePath)) {
      const liveHash = sha256File(livePath);
      if (liveHash === originalHash) {
        removeVerifiedFile(rollbackPath, [originalHash], `${label} duplicate rollback`);
      } else if (liveHash === replacementHash) {
        removeVerifiedFile(livePath, [replacementHash], `${label} interrupted replacement`);
        fs.renameSync(rollbackPath, livePath);
      } else {
        throw new Error(`Interrupted ${label} transaction found an unknown live file`);
      }
    } else {
      fs.renameSync(rollbackPath, livePath);
    }
  } else if (!fs.existsSync(livePath) || sha256File(livePath) !== originalHash) {
    throw new Error(`Interrupted ${label} transaction has no verified original or rollback file`);
  }
  removeVerifiedFile(stagedPath, [replacementHash], `${label} staged file`);
}

function journalStateShowsCommit(operation, installDirectory, transactionId, replacementAsarHash, replacementExeHash) {
  let state;
  try {
    state = readState(installDirectory);
  } catch {
    return false;
  }
  if (!state) return false;
  if (state.lastTransactionId !== transactionId) return false;
  if (operation === "restore") {
    return state.restored === true && state.original?.asarHash === replacementAsarHash && state.original?.exeHash === replacementExeHash;
  }
  return state.patched?.asarHash === replacementAsarHash && state.patched?.exeHash === replacementExeHash;
}

function recoverInterruptedTransaction(installDirectory) {
  const journalPath = transactionJournalPath(installDirectory);
  if (!fs.existsSync(journalPath)) return null;
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch (error) {
    throw new Error(`Interrupted transaction journal is unreadable and was preserved: ${journalPath}: ${error.message}`);
  }
  if (journal.schemaVersion !== 1 || !["apply", "repair", "restore"].includes(journal.operation) ||
      normalizePathForComparison(journal.installDirectory) !== normalizePathForComparison(installDirectory)) {
    throw new Error(`Interrupted transaction journal is invalid and was preserved: ${journalPath}`);
  }
  if (typeof journal.originalAssetsPresent !== "boolean" || typeof journal.replacementAssetsPresent !== "boolean" ||
      typeof journal.committed !== "boolean") {
    throw new Error(`Interrupted transaction journal has invalid state flags and was preserved: ${journalPath}`);
  }
  const originalAsarHash = validateHash(journal.originalAsarHash, "Journal original ASAR hash");
  const originalExeHash = validateHash(journal.originalExeHash, "Journal original EXE hash");
  const replacementAsarHash = validateHash(journal.replacementAsarHash, "Journal replacement ASAR hash");
  const replacementExeHash = validateHash(journal.replacementExeHash, "Journal replacement EXE hash");
  const originalAssetHashes = normalizedAssetHashes(journal.originalAssetHashes, "Journal original asset");
  const replacementAssetHashes = normalizedAssetHashes(journal.replacementAssetHashes, "Journal replacement asset");
  const paths = mutationPaths(installDirectory, journal.transactionId);
  assertMirasimClosed(paths.exePath);
  let committed = journal.committed === true;
  if (!committed && journalStateShowsCommit(
    journal.operation,
    installDirectory,
    journal.transactionId,
    replacementAsarHash,
    replacementExeHash,
  )) committed = true;

  recoverJournalFile(paths.asarPath, paths.rollbackAsar, paths.stagedAsar, originalAsarHash, replacementAsarHash, committed, "ASAR");
  recoverJournalFile(paths.exePath, paths.rollbackExe, paths.stagedExe, originalExeHash, replacementExeHash, committed, "EXE");
  asar.uncache(paths.asarPath);

  if (committed) {
    if (journal.replacementAssetsPresent) verifyInstalledAssetTree(paths.finalAssets, replacementAssetHashes);
    else if (fs.existsSync(paths.finalAssets)) throw new Error("Committed restore unexpectedly contains compatibility assets");
    if (fs.existsSync(paths.rollbackAssets) && Object.keys(originalAssetHashes).length > 0) {
      try {
        removeOwnedAssetTree(paths.rollbackAssets, originalAssetHashes, "Old compatibility asset directory");
      } catch {
        // Preserve modified/unowned old assets as a quarantine directory.
      }
    }
  } else if (fs.existsSync(paths.rollbackAssets)) {
    if (fs.existsSync(paths.finalAssets)) {
      removeOwnedAssetTree(paths.finalAssets, replacementAssetHashes, "Interrupted replacement asset directory");
    }
    fs.renameSync(paths.rollbackAssets, paths.finalAssets);
  } else if (journal.originalAssetsPresent) {
    if (!fs.existsSync(paths.finalAssets)) throw new Error("Interrupted transaction lost its original compatibility asset directory");
  } else if (fs.existsSync(paths.finalAssets)) {
    removeOwnedAssetTree(paths.finalAssets, replacementAssetHashes, "Interrupted replacement asset directory");
  }
  if (fs.existsSync(paths.stagedAssets)) {
    removeOwnedAssetTree(paths.stagedAssets, replacementAssetHashes, "Interrupted staged asset directory");
  }
  fs.rmSync(journalPath, { force: true });
  return { recovered: true, operation: journal.operation, committed };
}

function discoverInterruptedInstallation() {
  const transactionsDirectory = path.join(backupRoot(), "transactions");
  if (!fs.existsSync(transactionsDirectory)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(transactionsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[0-9a-f]{20}\.json$/.test(entry.name)) continue;
    const journalPath = path.join(transactionsDirectory, entry.name);
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      if (journal.schemaVersion !== 1 || typeof journal.installDirectory !== "string") continue;
      const candidate = fs.realpathSync.native(path.resolve(journal.installDirectory));
      if (!fs.statSync(candidate).isDirectory() || `${installId(candidate)}.json` !== entry.name) continue;
      mutationPaths(candidate, journal.transactionId);
      candidates.push(candidate);
    } catch {
      // Invalid journals are not trusted for automatic installation discovery.
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [normalizePathForComparison(candidate), candidate])).values()];
  if (unique.length > 1) {
    throw new Error("More than one interrupted Mirasim transaction was found. Pass --app with the intended installation directory.");
  }
  return unique[0] || null;
}

function resolveMutationInstallation(explicitPath) {
  try {
    return resolveInstallation(explicitPath);
  } catch (originalError) {
    if (!explicitPath) {
      const interrupted = discoverInterruptedInstallation();
      if (interrupted) return interrupted;
      throw originalError;
    }
    let candidate;
    try {
      candidate = fs.realpathSync.native(path.resolve(explicitPath));
    } catch {
      throw originalError;
    }
    if (!fs.statSync(candidate).isDirectory() || !fs.existsSync(transactionJournalPath(candidate))) throw originalError;
    return candidate;
  }
}

function readState(installDirectory) {
  const filePath = statePath(installDirectory);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read patch state ${filePath}: ${error.message}`);
  }
}

async function inspectFuses(exePath) {
  const wire = await getCurrentFuseWire(exePath);
  const enabled = (option) => wire[option] === 49;
  return {
    version: wire.version,
    runAsNode: enabled(FuseV1Options.RunAsNode),
    embeddedAsarIntegrityValidation: enabled(FuseV1Options.EnableEmbeddedAsarIntegrityValidation),
    onlyLoadAppFromAsar: enabled(FuseV1Options.OnlyLoadAppFromAsar),
  };
}

function runningMirasimProcesses(exePath) {
  if (process.platform !== "win32") return [];
  const script = [
    "$target=[IO.Path]::GetFullPath($env:MIRASIM_SSH_FIX_TARGET);",
    "$self=[int]$env:MIRASIM_SSH_FIX_SELF_PID;",
    "$items=@(Get-Process -Name Mirasim -ErrorAction SilentlyContinue |",
    "  Where-Object { $_.Id -ne $self } |",
    "  ForEach-Object { $proc=$_; try { $candidate=[IO.Path]::GetFullPath($proc.MainModule.FileName); if($candidate.Equals($target,[StringComparison]::OrdinalIgnoreCase)){ [pscustomobject]@{ ProcessId=$proc.Id; ExecutablePath=$candidate; AccessError=$null } } } catch { [pscustomobject]@{ ProcessId=$proc.Id; ExecutablePath=$null; AccessError=$_.Exception.Message } } });",
    "$items | ConvertTo-Json -Compress",
  ].join(" ");
  let output;
  try {
    output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, MIRASIM_SSH_FIX_TARGET: exePath, MIRASIM_SSH_FIX_SELF_PID: String(process.pid) },
    }).trim();
  } catch (error) {
    throw new Error(`Could not verify whether Mirasim is running: ${error.message}`);
  }
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function assertMirasimClosed(exePath) {
  const running = runningMirasimProcesses(exePath);
  if (running.length > 0) {
    const unknown = running.some((item) => !item.ExecutablePath);
    const detail = unknown ? " (at least one Mirasim process path could not be verified)" : "";
    throw new Error(`Mirasim is still running or cannot be ruled out (PID ${running.map((item) => item.ProcessId).join(", ")})${detail}. Close it normally and retry.`);
  }
}

function validateAssets() {
  const manifestPath = path.join(ASSET_SOURCE, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Linux compatibility asset manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const listed = new Set(Object.keys(manifest.files || {}));
  if (listed.size !== REQUIRED_ASSET_FILES.size || [...REQUIRED_ASSET_FILES].some((name) => !listed.has(name))) {
    throw new Error("Linux compatibility asset manifest does not match the fixed release inventory");
  }
  const hashes = {};
  for (const [name, metadata] of Object.entries(manifest.files || {})) {
    if (!REQUIRED_ASSET_FILES.has(name) || path.basename(name) !== name || metadata.releaseAsset !== true) {
      throw new Error(`Unexpected Linux compatibility asset entry: ${name}`);
    }
    const expected = validateHash(metadata.sha256, `Manifest hash for ${name}`);
    const filePath = path.join(ASSET_SOURCE, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required release asset is missing: ${name}. Download the complete release ZIP, not the source archive.`);
    }
    const actual = sha256File(filePath);
    if (actual !== expected) {
      throw new Error(`Linux compatibility asset failed SHA-256 verification: ${name}`);
    }
    hashes[`linux-compat/${name}`] = actual;
  }
  const askpassManifestPath = path.join(WINDOWS_ASKPASS_SOURCE, "manifest.json");
  if (!fs.existsSync(askpassManifestPath)) throw new Error(`Windows askpass asset manifest is missing: ${askpassManifestPath}`);
  const askpassManifest = JSON.parse(fs.readFileSync(askpassManifestPath, "utf8"));
  const askpassEntries = Object.entries(askpassManifest.files || {});
  if (askpassManifest.schemaVersion !== 1 || askpassEntries.length !== 1 || askpassEntries[0][0] !== "windows-askpass.exe") {
    throw new Error("Windows askpass asset manifest does not match the fixed release inventory");
  }
  const [askpassName, askpassMetadata] = askpassEntries[0];
  if (!askpassMetadata || askpassMetadata.releaseAsset !== true) {
    throw new Error(`Unexpected Windows askpass asset entry: ${askpassName}`);
  }
  const expectedAskpassHash = validateHash(askpassMetadata.sha256, `Manifest hash for ${askpassName}`);
  const askpassPath = path.join(WINDOWS_ASKPASS_SOURCE, askpassName);
  if (!fs.existsSync(askpassPath)) {
    throw new Error(`Required release asset is missing: ${askpassName}. Download the complete release ZIP, not the source archive.`);
  }
  const actualAskpassHash = sha256File(askpassPath);
  if (actualAskpassHash !== expectedAskpassHash) {
    throw new Error(`Windows askpass asset failed SHA-256 verification: ${askpassName}`);
  }
  hashes[askpassName] = actualAskpassHash;
  return { manifest, askpassManifest, hashes };
}

function assetStatus(resourcesDirectory) {
  const finalRoot = path.join(resourcesDirectory, "mirasim-ssh-fix");
  try {
    const { hashes } = validateAssets();
    verifyInstalledAssetTree(finalRoot, hashes);
    return { present: true, root: finalRoot };
  } catch (error) {
    return { present: false, root: finalRoot, error: error.message };
  }
}

function stageVerifiedAssets(stagedRoot, assetHashes) {
  const compatibilityRoot = path.join(stagedRoot, "linux-compat");
  fs.mkdirSync(compatibilityRoot, { recursive: true });
  for (const [relative, expected] of Object.entries(assetHashes)) {
    const safeRelative = checkedAssetRelativePath(relative);
    const fileName = path.basename(safeRelative);
    const source = relative === "windows-askpass.exe"
      ? path.join(WINDOWS_ASKPASS_SOURCE, fileName)
      : path.join(ASSET_SOURCE, fileName);
    const destination = path.join(stagedRoot, safeRelative);
    assertPathInside(stagedRoot, destination, "Staged compatibility asset");
    fs.copyFileSync(source, destination);
    if (sha256File(destination) !== expected) throw new Error(`Staged asset verification failed: ${relative}`);
  }
}

function verifyInstalledAssetTree(root, assetHashes) {
  const expectedFiles = new Set();
  const normalizedRoot = normalizePathForComparison(root);
  const expectedDirectories = new Set([normalizedRoot]);
  for (const [relative, expected] of Object.entries(assetHashes || {})) {
    const safeRelative = checkedAssetRelativePath(relative);
    const target = path.join(root, safeRelative);
    assertPathInside(root, target, "Installed compatibility asset");
    if (!fs.existsSync(target) || sha256File(target) !== validateHash(expected, `Asset hash for ${relative}`)) {
      throw new Error(`Compatibility asset is missing or modified: ${relative}`);
    }
    expectedFiles.add(normalizePathForComparison(target));
    let parent = path.dirname(target);
    while (normalizePathForComparison(parent) !== normalizedRoot) {
      expectedDirectories.add(normalizePathForComparison(parent));
      parent = path.dirname(parent);
    }
  }
  if (!fs.existsSync(root)) throw new Error("Compatibility asset directory is missing");
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const filePath = path.join(entry.parentPath || entry.path, entry.name);
    const normalized = normalizePathForComparison(filePath);
    if (entry.isDirectory() && expectedDirectories.has(normalized)) continue;
    if (!entry.isFile() || !expectedFiles.has(normalized)) {
      throw new Error(`Compatibility asset directory contains an unowned file: ${filePath}`);
    }
  }
}

async function status(options = {}) {
  const installDirectory = resolveInstallation(options.app);
  const app = inspectPackage(installDirectory);
  const version = app.packageJson.version;
  const mainSource = asar.extractFile(app.asarPath, "dist/main.cjs").toString("utf8");
  const patched = mainSource.includes(PATCH_MARKER);
  const supported = SUPPORTED_VERSIONS.has(version);
  if (patched && supported) patchMainSource(mainSource, version);
  else if (patched) verifyPatchedSource(mainSource);
  const fuses = await inspectFuses(app.exePath);
  const resourcesDirectory = path.dirname(app.asarPath);
  const assets = assetStatus(resourcesDirectory);
  const state = readState(installDirectory);
  let exeIntegrity = null;
  let exeIntegrityMatchesAsar = false;
  try {
    exeIntegrity = readExeIntegrity(app.exePath, false).lists;
    exeIntegrityMatchesAsar = exeIntegrity.length > 0 && exeIntegrity.every((list) => {
      const entries = list.entries.filter((entry) =>
        path.win32.normalize(entry.file).toLowerCase() === "resources\\app.asar");
      return entries.length === 1 && entries[0].alg === "SHA256" && entries[0].value === asarHeaderHash(app.asarPath);
    });
  } catch (error) {
    exeIntegrity = { error: error.message };
  }
  return {
    installDirectory,
    version,
    supported,
    patched,
    asarHash: sha256File(app.asarPath),
    asarHeaderHash: asarHeaderHash(app.asarPath),
    exeHash: sha256File(app.exePath),
    fuses,
    assets,
    state,
    exeIntegrity,
    exeIntegrityMatchesAsar,
  };
}

function copyVerifiedBackup(sourcePath, destinationPath, expectedHash) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (fs.existsSync(destinationPath)) {
    if (sha256File(destinationPath) !== expectedHash) throw new Error(`Existing backup failed verification: ${destinationPath}`);
    return;
  }
  const temporaryPath = `${destinationPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.copyFileSync(sourcePath, temporaryPath);
    if (sha256File(temporaryPath) !== expectedHash) throw new Error(`Backup failed verification: ${destinationPath}`);
    const descriptor = fs.openSync(temporaryPath, "r+");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporaryPath, destinationPath);
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
}

function cleanupTemporaryDirectory(tempRoot) {
  if (!tempRoot || !fs.existsSync(tempRoot)) return;
  assertPathInside(os.tmpdir(), tempRoot, "Temporary patch directory");
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
}

async function createAsarAndWait(sourceDirectory, destinationPath) {
  const stream = await asar.createPackage(sourceDirectory, destinationPath);
  // @electron/asar resolves createPackage() with the underlying WriteStream
  // immediately after calling end().  "finish" only means all bytes were
  // handed to the OS; wait for "close" so the archive can be reopened safely.
  if (stream.closed) return;
  await new Promise((resolve, reject) => {
    stream.once("close", resolve);
    stream.once("error", reject);
  });
}

async function applyUnlocked(options = {}) {
  if (process.platform !== "win32") throw new Error("This patcher can only apply changes on Windows");
  const beforeStatus = await status(options);
  if (!beforeStatus.supported) throw new Error(`Mirasim ${beforeStatus.version} is not supported. Update this patcher instead of forcing an unknown bundle.`);
  if (beforeStatus.patched) {
    if (!beforeStatus.assets.present || !beforeStatus.exeIntegrityMatchesAsar) {
      throw new Error("The code patch is present but its assets or EXE integrity metadata are unhealthy. Run repair.");
    }
    return { changed: false, status: beforeStatus, message: "Mirasim is already patched" };
  }
  const app = inspectPackage(beforeStatus.installDirectory);
  assertMirasimClosed(app.exePath);
  if (!beforeStatus.fuses.runAsNode) {
    throw new Error("This Mirasim build disables ELECTRON_RUN_AS_NODE, which the Windows SSH askpass bridge requires. It was not modified.");
  }
  if (normalizePathForComparison(process.execPath) === normalizePathForComparison(app.exePath)) {
    throw new Error("Apply requires an independent Node.js runtime so Mirasim.exe and its ASAR integrity metadata can be updated together.");
  }
  const unpackedPath = `${app.asarPath}.unpacked`;
  if (fs.existsSync(unpackedPath)) {
    throw new Error("This Mirasim build uses app.asar.unpacked. It needs a dedicated preservation profile and was not modified.");
  }
  const { hashes: assetHashes } = validateAssets();
  const originalAsarHash = beforeStatus.asarHash;
  const originalExeHash = beforeStatus.exeHash;
  const backupDirectory = path.join(
    backupRoot(),
    "backups",
    installId(app.installDirectory),
    beforeStatus.version,
    `${originalAsarHash}-${originalExeHash}`,
  );
  const backupAsar = path.join(backupDirectory, "app.asar");
  const backupExe = path.join(backupDirectory, "Mirasim.exe");
  copyVerifiedBackup(app.asarPath, backupAsar, originalAsarHash);
  copyVerifiedBackup(app.exePath, backupExe, originalExeHash);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-ssh-fix-"));
  const extracted = path.join(tempRoot, "app");
  const resourcesDirectory = path.dirname(app.asarPath);
  const transactionId = crypto.randomUUID().replace(/-/g, "");
  const stagedAsar = path.join(resourcesDirectory, `app.asar.mirasim-ssh-fix.${transactionId}.new`);
  const stagedExe = path.join(app.installDirectory, `Mirasim.exe.mirasim-ssh-fix.${transactionId}.new`);
  const rollbackAsar = path.join(resourcesDirectory, `app.asar.mirasim-ssh-fix.${transactionId}.rollback`);
  const rollbackExe = path.join(app.installDirectory, `Mirasim.exe.mirasim-ssh-fix.${transactionId}.rollback`);
  const finalAssets = path.join(resourcesDirectory, "mirasim-ssh-fix");
  const stagedAssets = path.join(resourcesDirectory, `.mirasim-ssh-fix.${transactionId}.new`);
  const rollbackAssets = path.join(resourcesDirectory, `.mirasim-ssh-fix.${transactionId}.rollback`);
  let asarMoved = false;
  let exeMoved = false;
  let assetsReplaced = false;
  let hadOriginalAssets = false;
  let committed = false;
  let transactionJournal = null;
  try {
    asar.extractAll(app.asarPath, extracted);
    const mainPath = path.join(extracted, "dist", "main.cjs");
    const originalMain = fs.readFileSync(mainPath, "utf8");
    const patchedMain = patchMainSource(originalMain, beforeStatus.version);
    fs.writeFileSync(mainPath, patchedMain.source, "utf8");
    await createAsarAndWait(extracted, stagedAsar);
    const stagedPackage = JSON.parse(asar.extractFile(stagedAsar, "package.json").toString("utf8"));
    if (stagedPackage.name !== "@mirasim/desktop" || stagedPackage.version !== beforeStatus.version) {
      throw new Error("Repacked app.asar changed the Mirasim package identity");
    }
    const expectedMainBuffer = Buffer.from(patchedMain.source, "utf8");
    const stagedMainBuffer = asar.extractFile(stagedAsar, "dist/main.cjs");
    if (!stagedMainBuffer.equals(expectedMainBuffer)) {
      const comparableLength = Math.min(stagedMainBuffer.length, expectedMainBuffer.length);
      let firstDifference = comparableLength;
      for (let index = 0; index < comparableLength; index += 1) {
        if (stagedMainBuffer[index] !== expectedMainBuffer[index]) {
          firstDifference = index;
          break;
        }
      }
      throw new Error(
        `Repacked main.cjs failed byte verification (expected ${expectedMainBuffer.length} bytes, got ${stagedMainBuffer.length}; first difference ${firstDifference})`,
      );
    }
    verifyPatchedSource(stagedMainBuffer.toString("utf8"));

    const updatedExe = buildExeWithUpdatedIntegrity(app.exePath, stagedAsar, Boolean(options.allowUnsignedOutput));
    const wasSigned = updatedExe.wasSigned;
    fs.writeFileSync(stagedExe, updatedExe.buffer);
    const exeIntegrityUpdated = true;

    stageVerifiedAssets(stagedAssets, assetHashes);

    // Close the update/parallel-patcher race immediately before the first move.
    assertMirasimClosed(app.exePath);
    asar.uncache(app.asarPath);
    if (sha256File(app.asarPath) !== originalAsarHash || sha256File(app.exePath) !== originalExeHash) {
      throw new Error("Mirasim changed while the patch was being prepared. No installation files were replaced.");
    }
    const currentPackage = inspectPackage(app.installDirectory);
    if (currentPackage.packageJson.version !== beforeStatus.version) {
      throw new Error("Mirasim was updated while the patch was being prepared. No installation files were replaced.");
    }
    transactionJournal = {
      operation: "apply",
      transactionId,
      committed: false,
      originalAsarHash,
      originalExeHash,
      replacementAsarHash: sha256File(stagedAsar),
      replacementExeHash: sha256File(stagedExe),
      originalAssetsPresent: fs.existsSync(finalAssets),
      replacementAssetsPresent: true,
      originalAssetHashes: beforeStatus.assets.present ? assetHashes : {},
      replacementAssetHashes: assetHashes,
    };
    writeTransactionJournal(app.installDirectory, transactionJournal);

    moveToRollbackVerified(app.asarPath, rollbackAsar, originalAsarHash, "Mirasim app.asar");
    asarMoved = true;
    publishStagedFileNoClobber(stagedAsar, app.asarPath, "Mirasim app.asar");
    asar.uncache(app.asarPath);
    if (exeIntegrityUpdated) {
      moveToRollbackVerified(app.exePath, rollbackExe, originalExeHash, "Mirasim.exe");
      exeMoved = true;
      publishStagedFileNoClobber(stagedExe, app.exePath, "Mirasim.exe");
    }
    if (fs.existsSync(finalAssets)) {
      moveAssetTreeToRollbackVerified(
        finalAssets,
        rollbackAssets,
        beforeStatus.assets.present ? assetHashes : null,
        "Existing compatibility asset directory",
      );
      hadOriginalAssets = true;
    }
    fs.renameSync(stagedAssets, finalAssets);
    assetsReplaced = true;

    const patchedAsarHash = sha256File(app.asarPath);
    const patchedExeHash = sha256File(app.exePath);
    patchMainSource(asar.extractFile(app.asarPath, "dist/main.cjs").toString("utf8"), beforeStatus.version);
    verifyInstalledAssetTree(finalAssets, assetHashes);
    if (exeIntegrityUpdated) {
      const expectedHeader = asarHeaderHash(app.asarPath);
      const lists = readExeIntegrity(app.exePath, false).lists;
      const entry = lists.flatMap((item) => item.entries).find((item) =>
        typeof item.file === "string" && path.win32.normalize(item.file).toLowerCase() === "resources\\app.asar");
      if (!entry || entry.value !== expectedHeader) throw new Error("Installed EXE contains stale ASAR integrity metadata");
    }

    const manifest = {
      schemaVersion: 1,
      toolVersion: TOOL_VERSION,
      lastTransactionId: transactionId,
      appliedAt: new Date().toISOString(),
      installDirectory: app.installDirectory,
      mirasimVersion: beforeStatus.version,
      fuses: beforeStatus.fuses,
      exeIntegrityUpdated,
      invalidatedAuthenticode: wasSigned,
      original: { asarHash: originalAsarHash, exeHash: originalExeHash, asarPath: backupAsar, exePath: backupExe },
      patched: { asarHash: patchedAsarHash, exeHash: patchedExeHash },
      assetHashes,
    };
    const afterStatus = await status({ app: app.installDirectory });
    if (!afterStatus.patched || !afterStatus.assets.present || !afterStatus.exeIntegrityMatchesAsar ||
        afterStatus.asarHash !== patchedAsarHash || afterStatus.exeHash !== patchedExeHash) {
      throw new Error("Post-install verification did not match the staged patch");
    }
    writeJsonAtomic(statePath(app.installDirectory), manifest);
    committed = true;
    transactionJournal.committed = true;
    try { writeTransactionJournal(app.installDirectory, transactionJournal); } catch {}
    try { writeJsonAtomic(path.join(backupDirectory, "manifest.json"), manifest); } catch {}
    const cleanupPending = [];
    try { removeVerifiedFile(rollbackAsar, [originalAsarHash], "Original ASAR rollback"); } catch (error) { cleanupPending.push(error.message); }
    try { removeVerifiedFile(rollbackExe, [originalExeHash], "Original EXE rollback"); } catch (error) { cleanupPending.push(error.message); }
    let assetQuarantine = null;
    if (hadOriginalAssets && fs.existsSync(rollbackAssets)) {
      if (beforeStatus.assets.present) {
        try { removeOwnedAssetTree(rollbackAssets, assetHashes, "Old compatibility asset directory"); } catch (error) { cleanupPending.push(error.message); }
      } else {
        assetQuarantine = rollbackAssets;
      }
    }
    if (cleanupPending.length === 0) {
      try { fs.rmSync(transactionJournalPath(app.installDirectory), { force: true }); } catch (error) { cleanupPending.push(error.message); }
    }
    afterStatus.state = manifest;
    let message = assetQuarantine
      ? `Windows Remote SSH patch applied; pre-existing assets were preserved at ${assetQuarantine}`
      : "Windows Remote SSH patch applied";
    if (cleanupPending.length > 0) message += "; committed cleanup is pending and will resume on the next operation";
    return {
      changed: true,
      status: afterStatus,
      backupDirectory,
      cleanupPending,
      message,
    };
  } catch (error) {
    if (!committed && transactionJournal) {
      try {
        recoverInterruptedTransaction(app.installDirectory);
      } catch (rollbackError) {
        error.message += `; automatic rollback also failed: ${rollbackError.message}`;
      }
    }
    throw error;
  } finally {
    try { cleanupTemporaryDirectory(tempRoot); } catch {}
    const recoveryPending = transactionJournal && fs.existsSync(transactionJournalPath(app.installDirectory));
    if (!recoveryPending) {
      try { removeFileIfExists(stagedAsar); } catch {}
      try { removeFileIfExists(stagedExe); } catch {}
      if (fs.existsSync(stagedAssets)) {
        try { removeOwnedAssetTree(stagedAssets, assetHashes, "Staged compatibility asset directory"); } catch {}
      }
    }
  }
}

async function apply(options = {}) {
  if (process.platform !== "win32") throw new Error("This patcher can only apply changes on Windows");
  const installDirectory = resolveMutationInstallation(options.app);
  const releaseLock = acquireInstallLock(installDirectory);
  try {
    recoverInterruptedTransaction(installDirectory);
    return await applyUnlocked({ ...options, app: installDirectory });
  } finally {
    releaseLock();
  }
}

async function restoreUnlocked(options = {}) {
  const current = await status(options);
  if (!current.state) throw new Error("No successful patch state was found for this installation");
  const app = inspectPackage(current.installDirectory);
  const state = validatePatchState(current.state, app);
  if (state.patched.asarHash !== current.asarHash || state.patched.exeHash !== current.exeHash) {
    throw new Error("Current Mirasim files do not match the recorded patched files. Restore was refused to protect a newer update or unrelated changes.");
  }
  assertMirasimClosed(app.exePath);
  if (normalizePathForComparison(process.execPath) === normalizePathForComparison(app.exePath) && state.original.exeHash !== state.patched.exeHash) {
    throw new Error("Restore needs to replace Mirasim.exe. Run this command with a separate Node.js installation.");
  }
  if (sha256File(state.original.asarPath) !== state.original.asarHash || sha256File(state.original.exePath) !== state.original.exeHash) {
    throw new Error("The recorded original backup failed SHA-256 verification");
  }
  const transactionId = crypto.randomUUID().replace(/-/g, "");
  const stagedAsar = `${app.asarPath}.mirasim-ssh-fix.${transactionId}.new`;
  const stagedExe = `${app.exePath}.mirasim-ssh-fix.${transactionId}.new`;
  const replacedAsar = `${app.asarPath}.mirasim-ssh-fix.${transactionId}.rollback`;
  const replacedExe = `${app.exePath}.mirasim-ssh-fix.${transactionId}.rollback`;
  const finalAssets = path.join(path.dirname(app.asarPath), "mirasim-ssh-fix");
  const replacedAssets = path.join(path.dirname(app.asarPath), `.mirasim-ssh-fix.${transactionId}.rollback`);
  let asarMoved = false;
  let exeMoved = false;
  let assetsMoved = false;
  let committed = false;
  let transactionJournal = null;
  try {
    verifyInstalledAssetTree(finalAssets, state.assetHashes);
    fs.copyFileSync(state.original.asarPath, stagedAsar);
    fs.copyFileSync(state.original.exePath, stagedExe);
    if (sha256File(stagedAsar) !== state.original.asarHash || sha256File(stagedExe) !== state.original.exeHash) {
      throw new Error("Staged restore files failed SHA-256 verification");
    }

    // Close the update/parallel-patcher race immediately before the first move.
    assertMirasimClosed(app.exePath);
    asar.uncache(app.asarPath);
    if (sha256File(app.asarPath) !== state.patched.asarHash || sha256File(app.exePath) !== state.patched.exeHash) {
      throw new Error("Mirasim changed while restore was being prepared. No installation files were replaced.");
    }
    transactionJournal = {
      operation: "restore",
      transactionId,
      committed: false,
      originalAsarHash: state.patched.asarHash,
      originalExeHash: state.patched.exeHash,
      replacementAsarHash: state.original.asarHash,
      replacementExeHash: state.original.exeHash,
      originalAssetsPresent: true,
      replacementAssetsPresent: false,
      originalAssetHashes: state.assetHashes,
      replacementAssetHashes: {},
    };
    writeTransactionJournal(app.installDirectory, transactionJournal);
    moveToRollbackVerified(app.asarPath, replacedAsar, state.patched.asarHash, "Patched Mirasim app.asar");
    asarMoved = true;
    publishStagedFileNoClobber(stagedAsar, app.asarPath, "Mirasim app.asar");
    asar.uncache(app.asarPath);
    if (state.original.exeHash !== state.patched.exeHash) {
      moveToRollbackVerified(app.exePath, replacedExe, state.patched.exeHash, "Patched Mirasim.exe");
      exeMoved = true;
      publishStagedFileNoClobber(stagedExe, app.exePath, "Mirasim.exe");
    } else {
      removeFileIfExists(stagedExe);
    }
    if (sha256File(app.asarPath) !== state.original.asarHash || sha256File(app.exePath) !== state.original.exeHash) {
      throw new Error("Restored files failed SHA-256 verification");
    }
    moveAssetTreeToRollbackVerified(finalAssets, replacedAssets, state.assetHashes, "Installed compatibility asset directory");
    assetsMoved = true;
    const restoredState = {
      ...state,
      lastTransactionId: transactionId,
      restoredAt: new Date().toISOString(),
      restored: true,
    };
    writeJsonAtomic(statePath(app.installDirectory), restoredState);
    committed = true;
    transactionJournal.committed = true;
    try { writeTransactionJournal(app.installDirectory, transactionJournal); } catch {}
    const cleanupPending = [];
    try { removeVerifiedFile(replacedAsar, [state.patched.asarHash], "Patched ASAR rollback"); } catch (error) { cleanupPending.push(error.message); }
    try { removeVerifiedFile(replacedExe, [state.patched.exeHash], "Patched EXE rollback"); } catch (error) { cleanupPending.push(error.message); }
    if (fs.existsSync(replacedAssets)) {
      try { removeOwnedAssetTree(replacedAssets, state.assetHashes, "Restored compatibility asset directory"); } catch (error) { cleanupPending.push(error.message); }
    }
    if (cleanupPending.length === 0) {
      try { fs.rmSync(transactionJournalPath(app.installDirectory), { force: true }); } catch (error) { cleanupPending.push(error.message); }
    }
    return {
      changed: true,
      cleanupPending,
      message: cleanupPending.length > 0
        ? "Original Mirasim files restored; committed cleanup is pending and will resume on the next operation"
        : "Original Mirasim files restored",
      installDirectory: app.installDirectory,
    };
  } catch (error) {
    if (!committed && transactionJournal) {
      try {
        recoverInterruptedTransaction(app.installDirectory);
      } catch (rollbackError) {
        error.message += `; restore rollback also failed: ${rollbackError.message}`;
      }
    }
    throw error;
  } finally {
    const recoveryPending = transactionJournal && fs.existsSync(transactionJournalPath(app.installDirectory));
    if (!recoveryPending) {
      try { removeFileIfExists(stagedAsar); } catch {}
      try { removeFileIfExists(stagedExe); } catch {}
    }
  }
}

async function restore(options = {}) {
  const installDirectory = resolveMutationInstallation(options.app);
  const releaseLock = acquireInstallLock(installDirectory);
  try {
    const recovery = recoverInterruptedTransaction(installDirectory);
    if (recovery?.operation === "restore" && recovery.committed) {
      return {
        changed: false,
        recovered: true,
        message: "Original Mirasim files were already restored; interrupted cleanup completed",
        installDirectory,
      };
    }
    return await restoreUnlocked({ ...options, app: installDirectory });
  } finally {
    releaseLock();
  }
}

async function repairUnlocked(options = {}) {
  const current = await status(options);
  if (!current.patched) return applyUnlocked(options);
  const app = inspectPackage(current.installDirectory);
  if (!current.state) throw new Error("The code patch exists but no version-bound patch state was found. Repair was refused.");
  const state = validatePatchState(current.state, app);
  if (state.patched.asarHash !== current.asarHash || state.patched.exeHash !== current.exeHash) {
    throw new Error("Current Mirasim files do not match the recorded patch state. Repair was refused.");
  }
  if (current.assets.present && current.exeIntegrityMatchesAsar) {
    return { changed: false, status: current, message: "Mirasim patch and assets are healthy" };
  }
  assertMirasimClosed(app.exePath);
  if (!current.fuses.runAsNode) throw new Error("ELECTRON_RUN_AS_NODE is disabled, so the Windows SSH askpass bridge cannot be repaired.");
  const { hashes: assetHashes } = validateAssets();
  const finalRoot = path.join(path.dirname(app.asarPath), "mirasim-ssh-fix");
  const transactionId = crypto.randomUUID().replace(/-/g, "");
  const stagedAssets = path.join(path.dirname(app.asarPath), `.mirasim-ssh-fix.${transactionId}.new`);
  const rollbackAssets = path.join(path.dirname(app.asarPath), `.mirasim-ssh-fix.${transactionId}.rollback`);
  const stagedExe = `${app.exePath}.mirasim-ssh-fix.${transactionId}.new`;
  const rollbackExe = `${app.exePath}.mirasim-ssh-fix.${transactionId}.rollback`;
  let hadOriginalAssets = false;
  let oldAssetsOwned = false;
  let assetsInstalled = false;
  let exeMoved = false;
  let committed = false;
  let exeIntegrityUpdated = false;
  let wasSigned = Boolean(state.invalidatedAuthenticode);
  let transactionJournal = null;
  try {
    stageVerifiedAssets(stagedAssets, assetHashes);
    if (fs.existsSync(finalRoot)) {
      try {
        verifyInstalledAssetTree(finalRoot, state.assetHashes);
        oldAssetsOwned = true;
      } catch {
        oldAssetsOwned = false;
      }
    }
    if (!current.exeIntegrityMatchesAsar) {
      if (normalizePathForComparison(process.execPath) === normalizePathForComparison(app.exePath)) {
        throw new Error("Repair needs an independent Node.js runtime to refresh Mirasim.exe integrity metadata.");
      }
      const updatedExe = buildExeWithUpdatedIntegrity(app.exePath, app.asarPath, Boolean(options.allowUnsignedOutput));
      wasSigned = updatedExe.wasSigned;
      fs.writeFileSync(stagedExe, updatedExe.buffer);
      exeIntegrityUpdated = true;
    }

    assertMirasimClosed(app.exePath);
    if (sha256File(app.asarPath) !== state.patched.asarHash || sha256File(app.exePath) !== state.patched.exeHash) {
      throw new Error("Mirasim changed while repair was being prepared. No installation files were replaced.");
    }
    transactionJournal = {
      operation: "repair",
      transactionId,
      committed: false,
      originalAsarHash: state.patched.asarHash,
      originalExeHash: state.patched.exeHash,
      replacementAsarHash: state.patched.asarHash,
      replacementExeHash: exeIntegrityUpdated ? sha256File(stagedExe) : state.patched.exeHash,
      originalAssetsPresent: fs.existsSync(finalRoot),
      replacementAssetsPresent: true,
      originalAssetHashes: state.assetHashes,
      replacementAssetHashes: assetHashes,
    };
    writeTransactionJournal(app.installDirectory, transactionJournal);
    if (fs.existsSync(finalRoot)) {
      moveAssetTreeToRollbackVerified(
        finalRoot,
        rollbackAssets,
        oldAssetsOwned ? state.assetHashes : null,
        "Existing compatibility asset directory",
      );
      hadOriginalAssets = true;
    }
    fs.renameSync(stagedAssets, finalRoot);
    assetsInstalled = true;
    if (exeIntegrityUpdated) {
      moveToRollbackVerified(app.exePath, rollbackExe, state.patched.exeHash, "Patched Mirasim.exe");
      exeMoved = true;
      publishStagedFileNoClobber(stagedExe, app.exePath, "Mirasim.exe");
    }

    verifyInstalledAssetTree(finalRoot, assetHashes);
    const patchedExeHash = sha256File(app.exePath);
    const expectedHeader = asarHeaderHash(app.asarPath);
    const integrityLists = readExeIntegrity(app.exePath, false).lists;
    if (integrityLists.length === 0 || integrityLists.some((list) => {
      const entries = list.entries.filter((entry) => path.win32.normalize(entry.file).toLowerCase() === "resources\\app.asar");
      return entries.length !== 1 || entries[0].alg !== "SHA256" || entries[0].value !== expectedHeader;
    })) {
      throw new Error("Repaired Mirasim.exe contains stale ASAR integrity metadata");
    }
    const repairedState = {
      ...state,
      toolVersion: TOOL_VERSION,
      lastTransactionId: transactionId,
      repairedAt: new Date().toISOString(),
      restored: false,
      exeIntegrityUpdated: state.exeIntegrityUpdated || exeIntegrityUpdated,
      invalidatedAuthenticode: wasSigned,
      patched: { ...state.patched, exeHash: patchedExeHash },
      assetHashes,
    };
    const afterStatus = await status({ app: app.installDirectory });
    if (!afterStatus.patched || !afterStatus.assets.present || !afterStatus.exeIntegrityMatchesAsar) {
      throw new Error("Post-repair verification failed");
    }
    writeJsonAtomic(statePath(app.installDirectory), repairedState);
    committed = true;
    transactionJournal.committed = true;
    try { writeTransactionJournal(app.installDirectory, transactionJournal); } catch {}
    try { writeJsonAtomic(path.join(path.dirname(state.original.asarPath), "manifest.json"), repairedState); } catch {}
    const cleanupPending = [];
    try { removeVerifiedFile(rollbackExe, [state.patched.exeHash], "Previous EXE rollback"); } catch (error) { cleanupPending.push(error.message); }
    let quarantine = null;
    if (hadOriginalAssets && fs.existsSync(rollbackAssets)) {
      if (oldAssetsOwned) {
        try { removeOwnedAssetTree(rollbackAssets, state.assetHashes, "Old compatibility asset directory"); } catch (error) { cleanupPending.push(error.message); }
      } else {
        quarantine = rollbackAssets;
      }
    }
    if (cleanupPending.length === 0) {
      try { fs.rmSync(transactionJournalPath(app.installDirectory), { force: true }); } catch (error) { cleanupPending.push(error.message); }
    }
    afterStatus.state = repairedState;
    let message = quarantine
      ? `Compatibility assets repaired; modified old assets were preserved at ${quarantine}`
      : "Compatibility assets and integrity metadata repaired";
    if (cleanupPending.length > 0) message += "; committed cleanup is pending and will resume on the next operation";
    return {
      changed: true,
      status: afterStatus,
      cleanupPending,
      message,
    };
  } catch (error) {
    if (!committed && transactionJournal) {
      try {
        recoverInterruptedTransaction(app.installDirectory);
      } catch (rollbackError) {
        error.message += `; repair rollback also failed: ${rollbackError.message}`;
      }
    }
    throw error;
  } finally {
    const recoveryPending = transactionJournal && fs.existsSync(transactionJournalPath(app.installDirectory));
    if (!recoveryPending) {
      try { removeFileIfExists(stagedExe); } catch {}
      if (fs.existsSync(stagedAssets)) {
        try { removeOwnedAssetTree(stagedAssets, assetHashes, "Staged compatibility asset directory"); } catch {}
      }
    }
  }
}

async function repair(options = {}) {
  const installDirectory = resolveMutationInstallation(options.app);
  const releaseLock = acquireInstallLock(installDirectory);
  try {
    recoverInterruptedTransaction(installDirectory);
    return await repairUnlocked({ ...options, app: installDirectory });
  } finally {
    releaseLock();
  }
}

module.exports = {
  apply,
  inspectFuses,
  repair,
  restore,
  status,
  validateAssets,
};
