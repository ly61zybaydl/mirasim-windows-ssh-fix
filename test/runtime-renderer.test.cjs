"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  activeRuntime,
  patchRuntimeRenderer,
  runtimeRendererStatus,
} = require("../src/install.cjs");

function lockedRenderer() {
  return [
    'const translations={"conn.ssh.title":"SSH Remote Host"};',
    "const desktop={remoteSsh:{}};",
    'function supports(platform){return platform!=="win32"}',
    "function panel(){if(!supports(desktop.platform))return 'unsupported';",
    'return {"data-testid":"ssh-unsupported",sshUnsupported:!supports(desktop.platform)}}',
  ].join("");
}

function createRuntime(appRoot, version) {
  const versionRoot = path.join(appRoot, version);
  const assets = path.join(versionRoot, "renderer", "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(versionRoot, "payload.json"), `${JSON.stringify({
    version,
    renderer: "renderer/index.html",
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(versionRoot, "renderer", "index.html"), "<!doctype html>\n", "utf8");
  const bundlePath = path.join(assets, `index-${version}.js`);
  fs.writeFileSync(bundlePath, lockedRenderer(), "utf8");
  return { versionRoot, bundlePath };
}

test("selects and patches the active downloaded runtime renderer", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-runtime-renderer-"));
  const appRoot = path.join(tempRoot, "app");
  const dataRoot = path.join(tempRoot, "patch-data");
  const oldAppRoot = process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT;
  const oldDataRoot = process.env.MIRASIM_SSH_FIX_DATA_DIR;
  process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT = appRoot;
  process.env.MIRASIM_SSH_FIX_DATA_DIR = dataRoot;
  t.after(() => {
    if (oldAppRoot === undefined) delete process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT;
    else process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT = oldAppRoot;
    if (oldDataRoot === undefined) delete process.env.MIRASIM_SSH_FIX_DATA_DIR;
    else process.env.MIRASIM_SSH_FIX_DATA_DIR = oldDataRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  createRuntime(appRoot, "0.0.206");
  const current = createRuntime(appRoot, "0.0.207");
  fs.writeFileSync(path.join(appRoot, "state.json"), '{"good":"0.0.207"}\n', "utf8");

  const selected = activeRuntime();
  assert.equal(selected.version, "0.0.207");
  assert.equal(selected.versionDirectory, current.versionRoot);
  assert.equal(runtimeRendererStatus(selected).locked, true);

  const first = patchRuntimeRenderer(selected);
  assert.deepEqual(first.changedFiles, [current.bundlePath]);
  assert.equal(first.status.unlocked, true);
  assert.equal(first.backups.length, 1);
  assert.equal(fs.readFileSync(first.backups[0].backupPath, "utf8"), lockedRenderer());

  const second = patchRuntimeRenderer(selected);
  assert.deepEqual(second.changedFiles, []);
  assert.equal(second.status.unlocked, true);
});

test("pending runtime takes priority over the current good runtime", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-runtime-pending-"));
  const appRoot = path.join(tempRoot, "app");
  const oldAppRoot = process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT;
  process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT = appRoot;
  t.after(() => {
    if (oldAppRoot === undefined) delete process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT;
    else process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT = oldAppRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  createRuntime(appRoot, "0.0.207");
  createRuntime(appRoot, "0.0.208");
  fs.writeFileSync(
    path.join(appRoot, "state.json"),
    '{"good":"0.0.207","pending":"0.0.208"}\n',
    "utf8",
  );
  assert.equal(activeRuntime().version, "0.0.208");
});

test("ignores a downloaded runtime that is not newer than the bundled app", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-runtime-bundled-"));
  const appRoot = path.join(tempRoot, "app");
  const oldAppRoot = process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT;
  process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT = appRoot;
  t.after(() => {
    if (oldAppRoot === undefined) delete process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT;
    else process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT = oldAppRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const dormant = createRuntime(appRoot, "0.0.207");
  createRuntime(appRoot, "0.0.208-beta.1");
  fs.writeFileSync(path.join(appRoot, "state.json"), '{"good":"0.0.207"}\n', "utf8");

  const selected = activeRuntime("0.0.208");
  assert.equal(selected, null);
  assert.deepEqual(patchRuntimeRenderer(selected).changedFiles, []);
  assert.equal(fs.readFileSync(dormant.bundlePath, "utf8"), lockedRenderer());
});

test("selects a future downloaded runtime over an older good runtime", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-runtime-future-"));
  const appRoot = path.join(tempRoot, "app");
  const oldAppRoot = process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT;
  process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT = appRoot;
  t.after(() => {
    if (oldAppRoot === undefined) delete process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT;
    else process.env.MIRASIM_SSH_FIX_RUNTIME_APP_ROOT = oldAppRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  createRuntime(appRoot, "0.0.207");
  const future = createRuntime(appRoot, "0.0.209");
  fs.writeFileSync(path.join(appRoot, "state.json"), '{"good":"0.0.207"}\n', "utf8");

  const selected = activeRuntime("0.0.208");
  assert.equal(selected.version, "0.0.209");
  assert.equal(selected.versionDirectory, future.versionRoot);
});
