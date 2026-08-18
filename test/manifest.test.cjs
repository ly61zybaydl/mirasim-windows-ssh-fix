"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const assetDirectory = path.join(root, "assets", "linux-compat");
const manifest = JSON.parse(fs.readFileSync(path.join(assetDirectory, "manifest.json"), "utf8"));

test("legacy runtime manifest lists the release assets", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.runtime, /^node-v\d+\.\d+\.\d+-linux-x64-glibc-\d+$/);
  assert.equal(Number.isInteger(manifest.nodeAbi), true);
  for (const [name, entry] of Object.entries(manifest.files)) {
    assert.equal(path.basename(name), name, `manifest path must be a plain filename: ${name}`);
    assert.equal(entry.releaseAsset, true, `${name} must be included in release ZIPs`);
  }
});

test("present legacy runtime assets are non-empty", (context) => {
  let checked = 0;
  for (const name of Object.keys(manifest.files)) {
    const filePath = path.join(assetDirectory, name);
    if (!fs.existsSync(filePath)) {
      context.diagnostic(`${name} is intentionally absent from a source-only checkout`);
      continue;
    }
    assert.ok(fs.statSync(filePath).size > 0, `${name} must not be empty`);
    checked += 1;
  }
  assert.ok(checked >= 2, "tracked installer/notices assets should always be checked");
});
