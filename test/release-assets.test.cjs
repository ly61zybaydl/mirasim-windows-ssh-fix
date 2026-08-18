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

test("release asset verifier parses an explicit directory", () => {
  const options = parseArguments(["--asset-dir", ".", "--json"]);
  assert.equal(options.assetDirectory, path.resolve("."));
  assert.equal(options.json, true);
  assert.throws(() => parseArguments(["--asset-dir"]), /requires a directory/);
  assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/);
});

test("release asset verifier rejects an injected file with the wrong hash", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-assets-test-"));
  try {
    fs.writeFileSync(
      path.join(directory, "node-v22.23.1-linux-x64-glibc-217.tar.xz"),
      "deliberately invalid public fixture",
    );
    assert.throws(() => verifyAssetDirectory(directory), /SHA-256 mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the pinned Windows runtime archive matches its separate manifest when present", (context) => {
  const assetDirectory = path.resolve(__dirname, "..", "assets", "windows-runtime");
  const archive = path.join(assetDirectory, "node-v22.23.1-win-x64.zip");
  if (!fs.existsSync(archive)) return context.skip("release-only Windows runtime archive is absent");
  const manifest = path.join(assetDirectory, "manifest.json");
  const result = verifyAssetDirectory(assetDirectory, manifest);
  assert.equal(result.runtime, "node-v22.23.1-win-x64");
  assert.equal(result.files.length, 1);
});

test("release asset verifier requires a strict versioned hash manifest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-manifest-test-"));
  try {
    const manifestPath = path.join(directory, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        files: {
          "asset.bin": {
            sha256: "A".repeat(64),
            releaseAsset: false,
          },
        },
      }),
    );
    assert.throws(
      () => verifyAssetDirectory(directory, manifestPath),
      /Unsupported asset manifest schema/,
    );

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        files: {
          "asset.bin": {
            sha256: "A".repeat(64),
            releaseAsset: true,
          },
        },
      }),
    );
    assert.throws(
      () => verifyAssetDirectory(directory, manifestPath),
      /Invalid lowercase SHA-256/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
