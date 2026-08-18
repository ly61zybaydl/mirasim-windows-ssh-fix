"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");
const { inspectPackage, resolveInstallation } = require("./detect.cjs");
const { PATCH_MARKER, TESTED_VERSIONS, patchMainSource } = require("./patch-main.cjs");

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

async function status(options = {}) {
  const installDirectory = resolveInstallation(options.app);
  const app = inspectPackage(installDirectory);
  const mainSource = asar.extractFile(app.asarPath, "dist/main.cjs").toString("utf8");
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
    patched: mainSource.includes(PATCH_MARKER),
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
  if (currentMain.includes(PATCH_MARKER)) {
    installAssets(path.dirname(app.asarPath));
    const currentStatus = await status({ app: app.installDirectory });
    return { changed: false, status: currentStatus, message: "Mirasim is already patched; helper files were refreshed" };
  }

  const version = app.packageJson.version;
  const backup = backupDirectory(version);
  const backupAsar = path.join(backup, "app.asar");
  fs.mkdirSync(backup, { recursive: true });
  if (!fs.existsSync(backupAsar)) fs.copyFileSync(app.asarPath, backupAsar);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-ssh-fix-"));
  const extracted = path.join(tempRoot, "app");
  const stagedAsar = path.join(tempRoot, "app.asar");
  try {
    asar.extractAll(app.asarPath, extracted);
    const mainPath = path.join(extracted, "dist", "main.cjs");
    const patchedMain = patchMainSource(fs.readFileSync(mainPath, "utf8"), version);
    fs.writeFileSync(mainPath, patchedMain.source, "utf8");
    await createAsar(extracted, stagedAsar);
    replaceAsar(stagedAsar, app.asarPath);
    installAssets(path.dirname(app.asarPath));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const newState = {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    installDirectory: app.installDirectory,
    mirasimVersion: version,
    backupAsar,
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
  const mainSource = asar.extractFile(app.asarPath, "dist/main.cjs").toString("utf8");
  if (!mainSource.includes(PATCH_MARKER)) return apply({ ...options, app: app.installDirectory });

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
  fs.rmSync(path.join(path.dirname(app.asarPath), "mirasim-ssh-fix"), { recursive: true, force: true });
  writeState({
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    installDirectory: app.installDirectory,
    mirasimVersion: version,
    backupAsar,
    restoredAt: new Date().toISOString(),
    restored: true,
  });
  return {
    changed: true,
    backupDirectory: backup,
    status: await status({ app: app.installDirectory }),
    message: "Original Mirasim app.asar restored",
  };
}

module.exports = {
  apply,
  repair,
  restore,
  status,
  validateAssets,
};
