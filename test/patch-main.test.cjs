"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const asar = require("@electron/asar");
const {
  TESTED_VERSIONS,
  patchMainSource,
  verifyPatchedSource,
} = require("../src/patch-main.cjs");

test("the versions exercised by fixtures are listed", () => {
  assert.deepEqual([...TESTED_VERSIONS].sort(), ["0.0.170", "0.0.203", "0.0.205"]);
});

test("patched-source verification fails closed for a public synthetic snippet", () => {
  assert.throws(() => verifyPatchedSource('"use strict"; void 0;'), /is missing/);
});

test("unknown Mirasim versions are attempted through semantic anchors", () => {
  assert.throws(
    () => patchMainSource("synthetic source", "9.9.9"),
    (error) => {
      assert.doesNotMatch(error.message, /not supported|version/i);
      assert.match(error.message, /expected marker was not found/);
      return true;
    },
  );
});

test("a synthetic source fails because required semantic anchors are absent", () => {
  assert.throws(
    () => patchMainSource('"use strict"; void 0;', "0.0.203"),
    /expected marker was not found/,
  );
});

for (const [version, environmentName] of [
  ["0.0.170", "MIRASIM_FIXTURE_0170_MAIN"],
  ["0.0.203", "MIRASIM_FIXTURE_0203_MAIN"],
  ["0.0.205", "MIRASIM_FIXTURE_0205_ASAR"],
]) {
  const fixturePath = process.env[environmentName];
  test(`optional local ${version} main bundle patches and is idempotent`, {
    skip: fixturePath ? false : `set ${environmentName} to run this local-only compatibility test`,
  }, () => {
    const original = environmentName.endsWith("_ASAR")
      ? asar.extractFile(fixturePath, "dist/main.cjs").toString("utf8")
      : fs.readFileSync(fixturePath, "utf8");
    const first = patchMainSource(original, version);
    assert.equal(first.alreadyPatched, false);
    verifyPatchedSource(first.source);
    const futureVersion = patchMainSource(original, "99.0.0");
    assert.equal(futureVersion.alreadyPatched, false);
    assert.equal(futureVersion.source, first.source);
    const second = patchMainSource(first.source, version);
    assert.equal(second.alreadyPatched, true);
    assert.equal(second.source, first.source);
  });
}
