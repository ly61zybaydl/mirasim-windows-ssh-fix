"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { sha256File } = require("../src/util.cjs");

const root = path.resolve(__dirname, "..");
const assetDirectory = path.join(root, "assets", "linux-compat");
const manifest = JSON.parse(fs.readFileSync(path.join(assetDirectory, "manifest.json"), "utf8"));

test("legacy runtime manifest has strict lowercase SHA-256 entries", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.runtime, /^node-v\d+\.\d+\.\d+-linux-x64-glibc-\d+$/);
  assert.equal(Number.isInteger(manifest.nodeAbi), true);
  for (const [name, entry] of Object.entries(manifest.files)) {
    assert.equal(path.basename(name), name, `manifest path must be a plain filename: ${name}`);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, `invalid SHA-256 for ${name}`);
    assert.equal(entry.releaseAsset, true, `${name} must be included in release ZIPs`);
  }
});

test("present legacy runtime assets match the manifest", (context) => {
  let checked = 0;
  for (const [name, entry] of Object.entries(manifest.files)) {
    const filePath = path.join(assetDirectory, name);
    if (!fs.existsSync(filePath)) {
      context.diagnostic(`${name} is intentionally absent from a source-only checkout`);
      continue;
    }
    assert.equal(sha256File(filePath), entry.sha256, `${name} hash mismatch`);
    checked += 1;
  }
  assert.ok(checked >= 2, "tracked installer/notices assets should always be checked");
});
