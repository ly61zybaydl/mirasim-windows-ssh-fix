"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");
const {
  RENDERER_PATCH_MARKER,
  analyzeRendererFiles,
  analyzeRendererSource,
  patchRendererDirectory,
  patchRendererSource,
  rendererBundleEntries,
  rendererBundlePaths,
} = require("../src/patch-renderer.cjs");

function syntheticRenderer(gate) {
  return [
    'const translations={"conn.ssh.title":"SSH Remote Host"};',
    "const desktop={remoteSsh:{}};",
    gate,
    "function panel(){if(!supports(desktop.platform))return 'unsupported';",
    "return {sshUnsupported:!supports(desktop.platform)}}",
  ].join("");
}

function rendererFromAsar(asarPath) {
  const candidates = rendererBundleEntries(asar.listPackage(asarPath));
  assert.equal(candidates.length, 1);
  return asar.extractFile(asarPath, candidates[0]).toString("utf8");
}

test("patches the Windows renderer gate and is idempotent", () => {
  const original = syntheticRenderer('function supports(platform){return platform!=="win32"}');
  assert.deepEqual(analyzeRendererSource(original), {
    applicable: true,
    patched: false,
    locked: true,
    unlocked: false,
    gateCount: 1,
  });

  const first = patchRendererSource(original);
  assert.equal(first.changed, true);
  assert.match(first.source, new RegExp(RENDERER_PATCH_MARKER));
  assert.match(first.source, /function supports\(platform\)\{return!0\}/);
  assert.equal(first.status.unlocked, true);
  assert.equal(first.status.locked, false);

  const second = patchRendererSource(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.alreadyUnlocked, true);
  assert.equal(second.source, first.source);
});

test("leaves a renderer without the Windows gate unchanged", () => {
  const original = syntheticRenderer("function supports(){return true}");
  const result = patchRendererSource(original);
  assert.equal(result.changed, false);
  assert.equal(result.alreadyUnlocked, true);
  assert.equal(result.status.unlocked, true);
});

test("patches extracted ASAR, app-version, and direct renderer directory layouts", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-renderer-layouts-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const layouts = [
    {
      name: "extracted ASAR root",
      input: path.join(tempRoot, "asar-root"),
      assets: path.join(tempRoot, "asar-root", "dist", "renderer", "assets"),
    },
    {
      name: "version app root",
      input: path.join(tempRoot, "0.0.207"),
      assets: path.join(tempRoot, "0.0.207", "renderer", "assets"),
    },
    {
      name: "direct renderer root",
      input: path.join(tempRoot, "renderer"),
      assets: path.join(tempRoot, "renderer", "assets"),
    },
  ];

  for (const layout of layouts) {
    await t.test(layout.name, () => {
      fs.mkdirSync(layout.assets, { recursive: true });
      const bundlePath = path.join(layout.assets, "index-fixture.js");
      fs.writeFileSync(
        bundlePath,
        syntheticRenderer('function supports(platform){return platform!=="win32"}'),
        "utf8",
      );
      assert.deepEqual(rendererBundlePaths(layout.input), [bundlePath]);

      const first = patchRendererDirectory(layout.input);
      assert.deepEqual(first.changedFiles, [bundlePath]);
      assert.equal(first.unlocked, true);
      assert.equal(analyzeRendererFiles([bundlePath]).unlocked, true);

      const second = patchRendererDirectory(layout.input);
      assert.deepEqual(second.changedFiles, []);
      assert.equal(second.unlocked, true);
    });
  }
});

for (const [version, environmentName, expectedLocked] of [
  ["0.0.170", "MIRASIM_FIXTURE_0170_RENDERER", false],
  ["0.0.203", "MIRASIM_FIXTURE_0203_RENDERER", false],
  ["0.0.205", "MIRASIM_FIXTURE_0205_ASAR", true],
  ["0.0.207", "MIRASIM_FIXTURE_0207_RENDERER", true],
  ["0.0.208", "MIRASIM_FIXTURE_0208_ASAR", false],
  ["0.0.214", "MIRASIM_FIXTURE_0214_ASAR", false],
]) {
  const fixturePath = process.env[environmentName];
  test(`optional local ${version} renderer has the expected Windows gate`, {
    skip: fixturePath ? false : `set ${environmentName} to run this local-only compatibility test`,
  }, () => {
    const original = environmentName.endsWith("_ASAR")
      ? rendererFromAsar(fixturePath)
      : fs.readFileSync(fixturePath, "utf8");
    const before = analyzeRendererSource(original);
    assert.equal(before.applicable, true);
    assert.equal(before.locked, expectedLocked);

    const result = patchRendererSource(original);
    assert.equal(result.status.unlocked, true);
    assert.equal(result.changed, expectedLocked);
    const second = patchRendererSource(result.source);
    assert.equal(second.changed, false);
    assert.equal(second.source, result.source);
  });
}
