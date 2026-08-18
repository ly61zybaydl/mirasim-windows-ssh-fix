#!/usr/bin/env node
"use strict";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
  process.stderr.write(`Mirasim SSH Fix requires independent Node.js 20 or newer (found ${process.versions.node}).\n`);
  process.exit(2);
}

const { apply, repair, restore, status } = require("./install.cjs");

function parseArguments(argv) {
  const options = { command: "status", json: false, app: null, allowUnsignedOutput: false };
  const commands = new Set(["detect", "status", "apply", "repair", "restore"]);
  const args = [...argv];
  if (args[0] && commands.has(args[0])) options.command = args.shift();
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--json") options.json = true;
    else if (argument === "--allow-unsigned-output") options.allowUnsignedOutput = true;
    else if (argument === "--app") {
      if (args.length === 0) throw new Error("--app requires a Mirasim installation directory");
      options.app = args.shift();
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return `Mirasim Windows Remote SSH Fix

Usage:
  mirasim-ssh-fix status [--app <directory>] [--json]
  mirasim-ssh-fix apply [--app <directory>] [--allow-unsigned-output]
  mirasim-ssh-fix repair [--app <directory>]
  mirasim-ssh-fix restore [--app <directory>]

Commands:
  status   Detect version, patch state, Electron fuses, and assets
  apply    Back up, patch, verify, and atomically replace Mirasim files
  repair   Reapply after an update or restore missing compatibility assets
  restore  Restore only the matching version/hash-bound backup

Unknown Mirasim versions are always refused. The tool never reads private-key contents.
`;
}

function humanStatus(result) {
  const lines = [
    `Mirasim ${result.version}`,
    `Directory: ${result.installDirectory}`,
    `Supported: ${result.supported ? "yes" : "no"}`,
    `Windows SSH patch: ${result.patched ? "installed" : "not installed"}`,
    `Compatibility assets: ${result.assets.present ? "verified" : "missing or invalid"}`,
    `ASAR SHA-256: ${result.asarHash}`,
    `Embedded ASAR validation: ${result.fuses.embeddedAsarIntegrityValidation ? "enabled" : "disabled"}`,
    `EXE ASAR metadata: ${result.exeIntegrityMatchesAsar ? "verified" : "missing, stale, or unreadable"}`,
  ];
  if (result.assets.error) lines.push(`Asset note: ${result.assets.error}`);
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  let result;
  if (options.command === "status" || options.command === "detect") result = await status(options);
  else if (options.command === "apply") result = await apply(options);
  else if (options.command === "repair") result = await repair(options);
  else if (options.command === "restore") result = await restore(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (options.command === "status" || options.command === "detect") {
    process.stdout.write(`${humanStatus(result)}\n`);
  } else {
    process.stdout.write(`${result.message}\n`);
    if (result.backupDirectory) process.stdout.write(`Backup: ${result.backupDirectory}\n`);
    if (result.status) process.stdout.write(`${humanStatus(result.status)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`Mirasim SSH Fix failed: ${error.message}\n`);
  process.exitCode = 1;
});
