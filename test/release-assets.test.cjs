"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  parseArguments,
  verifyAssetDirectory,
} = require("../scripts/verify-release-assets.cjs");

test("release asset tool parses an explicit directory", () => {
  const options = parseArguments(["--asset-dir", ".", "--json"]);
  assert.equal(options.assetDirectory, path.resolve("."));
  assert.equal(options.json, true);
  assert.throws(() => parseArguments(["--asset-dir"]), /requires a directory/);
  assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/);
});

test("release asset tool lists files selected by a manifest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-assets-test-"));
  try {
    const manifestPath = path.join(directory, "manifest.json");
    fs.writeFileSync(path.join(directory, "asset.bin"), "fixture");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        runtime: "example-runtime",
        files: {
          "asset.bin": { releaseAsset: true },
          "source-only.txt": { releaseAsset: false },
        },
      }),
    );

    const result = verifyAssetDirectory(directory, manifestPath);
    assert.equal(result.runtime, "example-runtime");
    assert.deepEqual(result.files.map((file) => file.name), ["asset.bin"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("release asset tool reports a missing file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-assets-missing-"));
  try {
    const manifestPath = path.join(directory, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ files: { "missing.bin": { releaseAsset: true } } }),
    );
    assert.throws(
      () => verifyAssetDirectory(directory, manifestPath),
      /Required release asset is missing/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows runtime archive follows its separate manifest when present", (context) => {
  const assetDirectory = path.resolve(__dirname, "..", "assets", "windows-runtime");
  const archive = path.join(assetDirectory, "node-v22.23.1-win-x64.zip");
  if (!fs.existsSync(archive)) return context.skip("release-only Windows runtime archive is absent");
  const manifest = path.join(assetDirectory, "manifest.json");
  const result = verifyAssetDirectory(assetDirectory, manifest);
  assert.equal(result.runtime, "node-v22.23.1-win-x64");
  assert.deepEqual(result.files.map((file) => file.name), ["node-v22.23.1-win-x64.zip"]);
});
