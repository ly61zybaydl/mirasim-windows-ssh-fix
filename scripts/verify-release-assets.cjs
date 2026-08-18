#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256File } = require("../src/util.cjs");

function usage() {
  return "Usage: node scripts/verify-release-assets.cjs [--asset-dir <directory>] [--manifest <file>] [--json]\n";
}

function parseArguments(arguments_) {
  const options = {
    assetDirectory: path.resolve(__dirname, "..", "assets", "linux-compat"),
    manifestPath: path.resolve(__dirname, "..", "assets", "linux-compat", "manifest.json"),
    json: false,
  };
  const args = [...arguments_];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--asset-dir") {
      if (args.length === 0) throw new Error("--asset-dir requires a directory");
      options.assetDirectory = path.resolve(args.shift());
    } else if (argument === "--manifest") {
      if (args.length === 0) throw new Error("--manifest requires a file");
      options.manifestPath = path.resolve(args.shift());
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function verifyAssetDirectory(assetDirectory, manifestPath = path.resolve(__dirname, "..", "assets", "linux-compat", "manifest.json")) {
  if (!fs.existsSync(manifestPath)) throw new Error(`Asset manifest is missing: ${manifestPath}`);
  const repositoryAssetDirectory = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Asset manifest must be a JSON object");
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported asset manifest schema: ${manifest.schemaVersion}`);
  }
  if (manifest.files === null || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Asset manifest files must be a JSON object");
  }
  const entries = Object.entries(manifest.files);
  if (entries.length === 0) throw new Error("Asset manifest must declare at least one file");
  const files = [];
  for (const [name, entry] of entries) {
    if (
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      path.basename(name) !== name
    ) {
      throw new Error(`Unsafe manifest filename: ${name}`);
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid manifest entry for ${name}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid lowercase SHA-256 for ${name}`);
    }
    if (entry.releaseAsset !== true) {
      throw new Error(`Manifest file is not marked as a release asset: ${name}`);
    }
    const injectedPath = path.join(assetDirectory, name);
    const repositoryPath = path.join(repositoryAssetDirectory, name);
    const filePath = fs.existsSync(injectedPath) ? injectedPath : repositoryPath;
    if (!fs.existsSync(filePath)) throw new Error(`Required release asset is missing: ${name}`);
    const actual = sha256File(filePath);
    if (actual !== entry.sha256) {
      throw new Error(`SHA-256 mismatch for ${name}: expected ${entry.sha256}, got ${actual}`);
    }
    files.push({ name, path: filePath, sha256: actual });
  }
  return { manifestPath, runtime: manifest.runtime, target: manifest.target, files };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = verifyAssetDirectory(options.assetDirectory, options.manifestPath);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const file of result.files) process.stdout.write(`verified ${file.sha256}  ${file.name}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Release asset verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, verifyAssetDirectory };
