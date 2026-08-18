"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const cliPath = path.resolve(__dirname, "..", "src", "cli.cjs");

function runCli(arguments_) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, MIRASIM_SSH_FIX_NO_PAUSE: "1" },
    windowsHide: true,
  });
}

test("--help is self-contained and successful", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /Unknown Mirasim versions are always refused/);
});

test("an unknown argument is rejected without probing the machine", () => {
  const result = runCli(["--definitely-unknown"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument/);
});

test("--app without a value is rejected", () => {
  const result = runCli(["status", "--app"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a Mirasim installation directory/);
});
