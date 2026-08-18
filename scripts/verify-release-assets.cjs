#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entries = Object.entries(manifest.files || {});
  if (entries.length === 0) throw new Error(`No release files are listed in ${manifestPath}`);

  const repositoryAssetDirectory = path.dirname(manifestPath);
  const files = entries
    .filter(([, entry]) => entry && entry.releaseAsset === true)
    .map(([name]) => {
      const injectedPath = path.join(assetDirectory, name);
      const repositoryPath = path.join(repositoryAssetDirectory, name);
      const filePath = fs.existsSync(injectedPath) ? injectedPath : repositoryPath;
      if (!fs.existsSync(filePath)) throw new Error(`Required release asset is missing: ${name}`);
      return { name, path: filePath };
    });

  return {
    manifestPath,
    runtime: manifest.runtime,
    source: manifest.source,
    target: manifest.target,
    files,
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = verifyAssetDirectory(options.assetDirectory, options.manifestPath);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else for (const file of result.files) process.stdout.write(`found ${file.name}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Release asset check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, verifyAssetDirectory };
