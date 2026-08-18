"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");
const { inspectPackage, resolveInstallation } = require("./detect.cjs");
const {
  TESTED_VERSIONS,
  isMainPatchCurrent,
  patchMainSource,
} = require("./patch-main.cjs");
const {
  analyzeRendererFiles,
  analyzeRendererSources,
  patchRendererDirectory,
  patchRendererSource,
  rendererBundleEntries,
  rendererBundlePaths,
} = require("./patch-renderer.cjs");

const TOOL_VERSION = require("../package.json").version;
const TOOL_ROOT = path.resolve(__dirname, "..");
const ASSET_SOURCE = path.join(TOOL_ROOT, "assets", "linux-compat");
const WINDOWS_ASKPASS_SOURCE = path.join(TOOL_ROOT, "assets", "windows-askpass");
const ASSET_FILES = [
  {
    source: path.join(ASSET_SOURCE, "node-v22.23.1-linux-x64-glibc-217.tar.xz"),
    relative: path.join("linux-compat", "node-v22.23.1-linux-x64-glibc-217.tar.xz"),
  },
  {
    source: path.join(ASSET_SOURCE, "pty-node-v127-glibc217.node"),
    relative: path.join("linux-compat", "pty-node-v127-glibc217.node"),
  },
  {
    source: path.join(ASSET_SOURCE, "install-legacy-runtime.sh"),
    relative: path.join("linux-compat", "install-legacy-runtime.sh"),
  },
  {
    source: path.join(ASSET_SOURCE, "THIRD_PARTY_NOTICES.txt"),
    relative: path.join("linux-compat", "THIRD_PARTY_NOTICES.txt"),
  },
  {
    source: path.join(WINDOWS_ASKPASS_SOURCE, "windows-askpass.exe"),
    relative: "windows-askpass.exe",
  },
];

function dataRoot() {
  if (process.env.MIRASIM_SSH_FIX_DATA_DIR) {
    return path.resolve(process.env.MIRASIM_SSH_FIX_DATA_DIR);
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "MirasimRemoteSshPatcher");
}

function backupDirectory(version) {
  return path.join(dataRoot(), "backups", version);
}

function mirasimHome() {
  if (process.env.MIRASIM_HOME) return path.resolve(process.env.MIRASIM_HOME);
  return path.join(os.homedir(), ".mirasim");
}

function runtimeAppRoot() {
  if (process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT) {
    return path.resolve(process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT);
  }
  return path.join(mirasimHome(), "app");
}

function parseSemanticVersion(version) {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] === undefined ? null : match[4].split("."),
  };
}

function compareSemanticVersions(left, right) {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    if (parsedLeft.core[index] !== parsedRight.core[index]) {
      return parsedLeft.core[index] < parsedRight.core[index] ? -1 : 1;
    }
  }
  if (parsedLeft.prerelease === null || parsedRight.prerelease === null) {
    if (parsedLeft.prerelease === parsedRight.prerelease) return 0;
    return parsedLeft.prerelease === null ? 1 : -1;
  }
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function readRuntimePayload(versionDirectory) {
  const payloadPath = path.join(versionDirectory, "payload.json");
  if (!fs.existsSync(payloadPath)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
    if (typeof payload.version !== "string" || typeof payload.renderer !== "string") return null;
    const rendererIndex = path.resolve(versionDirectory, payload.renderer);
    if (!fs.existsSync(rendererIndex)) return null;
    return {
      version: payload.version,
      versionDirectory,
      rendererIndex,
      rendererDirectory: path.dirname(rendererIndex),
    };
  } catch {
    return null;
  }
}

function activeRuntime(bundledVersion = null) {
  if (process.env.MIRASIM_APP_DIR) {
    const selected = readRuntimePayload(path.resolve(process.env.MIRASIM_APP_DIR));
    if (selected) return selected;
  }

  if (bundledVersion !== null && parseSemanticVersion(bundledVersion) === null) {
    throw new Error(`Could not compare the bundled Mirasim version: ${bundledVersion}`);
  }

  const root = runtimeAppRoot();
  if (!fs.existsSync(root)) return null;
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  } catch {
    state = {};
  }

  const preferred = [];
  if (typeof state.pending === "string" && state.pending !== state.good) preferred.push(state.pending);
  if (typeof state.good === "string") preferred.push(state.good);
  const versions = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => {
      const comparison = compareSemanticVersions(right, left);
      return comparison === null
        ? right.localeCompare(left, undefined, { numeric: true })
        : comparison;
    });
  preferred.push(...versions);

  for (const version of [...new Set(preferred)]) {
    const selected = readRuntimePayload(path.join(root, version));
    if (!selected) continue;
    if (bundledVersion !== null) {
      const comparison = compareSemanticVersions(selected.version, bundledVersion);
      if (comparison === null || comparison <= 0) continue;
    }
    return selected;
  }
  return null;
}

function runtimeRendererStatus(runtime) {
  if (!runtime) return null;
  return analyzeRendererFiles(rendererBundlePaths(runtime.rendererDirectory));
}

function runtimeBackupPath(runtime, filePath) {
  const relative = path.relative(runtime.versionDirectory, filePath);
  return path.join(dataRoot(), "backups", "runtime", runtime.version, relative);
}

function patchRuntimeRenderer(runtime) {
  if (!runtime) return { changedFiles: [], backups: [], status: null };
  const filePaths = rendererBundlePaths(runtime.rendererDirectory);
  const changedFiles = [];
  const backups = [];
  for (const filePath of filePaths) {
    const result = patchRendererSource(fs.readFileSync(filePath, "utf8"));
    if (!result.changed) continue;
    const backupPath = runtimeBackupPath(runtime, filePath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(filePath, result.source, "utf8");
    changedFiles.push(filePath);
    backups.push({
      version: runtime.version,
      originalPath: filePath,
      backupPath,
    });
  }
  return {
    changedFiles,
    backups,
    status: runtimeRendererStatus(runtime),
  };
}

function mergeRuntimeBackups(existing, added) {
  const records = new Map();
  for (const item of [...(existing || []), ...(added || [])]) {
    if (!item || typeof item.originalPath !== "string" || typeof item.backupPath !== "string") continue;
    records.set(path.resolve(item.originalPath).toLowerCase(), item);
  }
  return [...records.values()];
}

function statePath() {
  return path.join(dataRoot(), "state.json");
}

function readState() {
  const filePath = statePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read patch state ${filePath}: ${error.message}`);
  }
}

function writeState(state) {
  const filePath = statePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function validateAssets() {
  const missing = ASSET_FILES.filter((item) => !fs.existsSync(item.source));
  if (missing.length > 0) {
    throw new Error(
      `Required release files are missing: ${missing.map((item) => path.basename(item.source)).join(", ")}. ` +
      "Use the complete Windows release ZIP.",
    );
  }
  return { files: ASSET_FILES.map((item) => ({ ...item })) };
}

function installedAssets(resourcesDirectory) {
  const root = path.join(resourcesDirectory, "mirasim-ssh-fix");
  const missing = ASSET_FILES
    .map((item) => item.relative)
    .filter((relative) => !fs.existsSync(path.join(root, relative)));
  return {
    present: missing.length === 0,
    root,
    missing,
  };
}

function installAssets(resourcesDirectory) {
  const { files } = validateAssets();
  const root = path.join(resourcesDirectory, "mirasim-ssh-fix");
  fs.rmSync(root, { recursive: true, force: true });
  for (const item of files) {
    const destination = path.join(root, item.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(item.source, destination);
  }
  return root;
}

function assertMirasimClosed(exePath) {
  if (process.platform !== "win32") return;
  const script = [
    "$target=[IO.Path]::GetFullPath($env:MIRASIM_SSH_FIX_TARGET);",
    "$running=@(Get-Process -Name Mirasim -ErrorAction SilentlyContinue | Where-Object {",
    "  try { [IO.Path]::GetFullPath($_.Path).Equals($target,[StringComparison]::OrdinalIgnoreCase) } catch { $false }",
    "});",
    "$running.Id -join ','",
  ].join(" ");
  let output = "";
  try {
    output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, MIRASIM_SSH_FIX_TARGET: exePath },
    }).trim();
  } catch {
    return;
  }
  if (output) throw new Error(`Mirasim is running (PID ${output}). Close it and retry.`);
}

async function createAsar(sourceDirectory, destinationPath) {
  fs.rmSync(destinationPath, { force: true });
  const stream = await asar.createPackage(sourceDirectory, destinationPath);
  if (stream.closed) return;
  await new Promise((resolve, reject) => {
    stream.once("close", resolve);
    stream.once("error", reject);
  });
}

function replaceAsar(stagedPath, livePath) {
  asar.uncache(livePath);
  fs.copyFileSync(stagedPath, livePath);
  asar.uncache(livePath);
}

function rendererStatusFromAsar(asarPath) {
  const entries = rendererBundleEntries(asar.listPackage(asarPath));
  return analyzeRendererSources(entries.map((entry) => ({
    path: entry,
    source: asar.extractFile(asarPath, entry).toString("utf8"),
  })));
}

async function status(options = {}) {
  const installDirectory = resolveInstallation(options.app);
  const app = inspectPackage(installDirectory);
  const mainSource = asar.extractFile(app.asarPath, "dist/main.cjs").toString("utf8");
  const mainPatched = isMainPatchCurrent(mainSource);
  const bundledFrontend = rendererStatusFromAsar(app.asarPath);
  const runtime = activeRuntime(app.packageJson.version);
  const runtimeFrontend = runtimeRendererStatus(runtime);
  const frontend = runtimeFrontend && runtimeFrontend.applicable
    ? runtimeFrontend
    : bundledFrontend;
  const state = readState();
  const relevantState = state && typeof state.installDirectory === "string" &&
    path.resolve(state.installDirectory) === path.resolve(app.installDirectory)
    ? state
    : null;
  return {
    installDirectory: app.installDirectory,
    version: app.packageJson.version,
    supported: true,
    testedVersion: TESTED_VERSIONS.has(app.packageJson.version),
    patched: mainPatched && frontend.unlocked,
    mainPatched,
    frontend,
    bundledFrontend,
    runtime: runtime ? {
      version: runtime.version,
      versionDirectory: runtime.versionDirectory,
      rendererIndex: runtime.rendererIndex,
      frontend: runtimeFrontend,
    } : null,
    assets: installedAssets(path.dirname(app.asarPath)),
    state: relevantState,
  };
}

async function apply(options = {}) {
  if (process.platform !== "win32") throw new Error("This patcher can only apply changes on Windows");
  const installDirectory = resolveInstallation(options.app);
  const app = inspectPackage(installDirectory);
  assertMirasimClosed(app.exePath);

  const currentMain = asar.extractFile(app.asarPath, "dist/main.cjs").toString("utf8");
  const currentBundledFrontend = rendererStatusFromAsar(app.asarPath);
  const runtime = activeRuntime(app.packageJson.version);
  const currentRuntimeFrontend = runtimeRendererStatus(runtime);
  const asarComplete = isMainPatchCurrent(currentMain) &&
    currentBundledFrontend.unlocked;
  const runtimeComplete = !runtime || (currentRuntimeFrontend && currentRuntimeFrontend.unlocked);
  if (asarComplete && runtimeComplete) {
    installAssets(path.dirname(app.asarPath));
    const currentStatus = await status({ app: app.installDirectory });
    return { changed: false, status: currentStatus, message: "Mirasim is already patched; helper files were refreshed" };
  }

  const version = app.packageJson.version;
  const backup = backupDirectory(version);
  const backupAsar = path.join(backup, "app.asar");
  fs.mkdirSync(backup, { recursive: true });
  if (!fs.existsSync(backupAsar)) fs.copyFileSync(app.asarPath, backupAsar);

  if (!asarComplete) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-ssh-fix-"));
    const extracted = path.join(tempRoot, "app");
    const stagedAsar = path.join(tempRoot, "app.asar");
    try {
      asar.extractAll(app.asarPath, extracted);
      const mainPath = path.join(extracted, "dist", "main.cjs");
      const patchedMain = patchMainSource(fs.readFileSync(mainPath, "utf8"), version);
      fs.writeFileSync(mainPath, patchedMain.source, "utf8");
      const patchedFrontend = patchRendererDirectory(extracted);
      if (!patchedFrontend.unlocked) {
        throw new Error("Could not locate the bundled Mirasim Remote SSH frontend");
      }
      await createAsar(extracted, stagedAsar);
      replaceAsar(stagedAsar, app.asarPath);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const runtimeResult = patchRuntimeRenderer(runtime);
  if (runtime && (!runtimeResult.status || !runtimeResult.status.unlocked)) {
    throw new Error(`Could not locate the active Mirasim ${runtime.version} Remote SSH frontend`);
  }
  installAssets(path.dirname(app.asarPath));

  const previousState = readState();
  const previousRuntimeBackups = previousState && typeof previousState.installDirectory === "string" &&
    path.resolve(previousState.installDirectory) === path.resolve(app.installDirectory)
    ? previousState.runtimeBackups
    : [];

  const newState = {
    schemaVersion: 2,
    toolVersion: TOOL_VERSION,
    installDirectory: app.installDirectory,
    mirasimVersion: version,
    backupAsar,
    runtimeVersion: runtime ? runtime.version : null,
    runtimeBackups: mergeRuntimeBackups(previousRuntimeBackups, runtimeResult.backups),
    appliedAt: new Date().toISOString(),
    restored: false,
  };
  writeState(newState);
  const afterStatus = await status({ app: app.installDirectory });
  return {
    changed: true,
    backupDirectory: backup,
    status: afterStatus,
    message: "Mirasim SSH patch applied",
  };
}

async function repair(options = {}) {
  const installDirectory = resolveInstallation(options.app);
  const app = inspectPackage(installDirectory);
  assertMirasimClosed(app.exePath);
  const currentStatus = await status({ app: app.installDirectory });
  if (!currentStatus.patched) return apply({ ...options, app: app.installDirectory });

  installAssets(path.dirname(app.asarPath));
  const currentState = readState();
  if (currentState && typeof currentState.installDirectory === "string" &&
      path.resolve(currentState.installDirectory) === path.resolve(app.installDirectory)) {
    writeState({
      ...currentState,
      toolVersion: TOOL_VERSION,
      repairedAt: new Date().toISOString(),
      restored: false,
    });
  }
  return {
    changed: true,
    status: await status({ app: app.installDirectory }),
    message: "Mirasim SSH patch helper files repaired",
  };
}

async function restore(options = {}) {
  const installDirectory = resolveInstallation(options.app);
  const app = inspectPackage(installDirectory);
  assertMirasimClosed(app.exePath);
  const previousState = readState();
  const runtimeBackups = previousState && typeof previousState.installDirectory === "string" &&
    path.resolve(previousState.installDirectory) === path.resolve(app.installDirectory)
    ? previousState.runtimeBackups || []
    : [];
  const version = app.packageJson.version;
  const backup = backupDirectory(version);
  const backupAsar = path.join(backup, "app.asar");
  if (!fs.existsSync(backupAsar)) {
    throw new Error(`No app.asar backup was found for Mirasim ${version}: ${backupAsar}`);
  }

  const stagedAsar = path.join(path.dirname(app.asarPath), "app.asar.mirasim-ssh-fix.restore");
  try {
    fs.copyFileSync(backupAsar, stagedAsar);
    replaceAsar(stagedAsar, app.asarPath);
  } finally {
    fs.rmSync(stagedAsar, { force: true });
  }
  for (const item of runtimeBackups) {
    if (!item || typeof item.originalPath !== "string" || typeof item.backupPath !== "string") continue;
    if (!fs.existsSync(item.backupPath) || !fs.existsSync(path.dirname(item.originalPath))) continue;
    fs.copyFileSync(item.backupPath, item.originalPath);
  }
  fs.rmSync(path.join(path.dirname(app.asarPath), "mirasim-ssh-fix"), { recursive: true, force: true });
  writeState({
    schemaVersion: 2,
    toolVersion: TOOL_VERSION,
    installDirectory: app.installDirectory,
    mirasimVersion: version,
    backupAsar,
    runtimeBackups,
    restoredAt: new Date().toISOString(),
    restored: true,
  });
  return {
    changed: true,
    backupDirectory: backup,
    status: await status({ app: app.installDirectory }),
    message: "Original Mirasim files restored",
  };
}

module.exports = {
  apply,
  activeRuntime,
  patchRuntimeRenderer,
  repair,
  restore,
  runtimeRendererStatus,
  status,
  validateAssets,
};
