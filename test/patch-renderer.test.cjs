"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const asar = require("@electron/asar");
const {
  RENDERER_PATCH_MARKER,
  analyzeRendererSource,
  patchRendererSource,
  rendererBundleEntries,
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

for (const [version, environmentName, expectedLocked] of [
  ["0.0.170", "MIRASIM_FIXTURE_0170_RENDERER", false],
  ["0.0.203", "MIRASIM_FIXTURE_0203_RENDERER", false],
  ["0.0.205", "MIRASIM_FIXTURE_0205_ASAR", true],
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
