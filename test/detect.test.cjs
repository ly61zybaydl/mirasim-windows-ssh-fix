"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isMirasimDirectory, resolveInstallation } = require("../src/detect.cjs");

function makeDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-detect-test-"));
}

test("isMirasimDirectory requires both executable and ASAR paths", () => {
  const directory = makeDirectory();
  try {
    assert.equal(isMirasimDirectory(directory), false);
    fs.writeFileSync(path.join(directory, "Mirasim.exe"), "placeholder");
    assert.equal(isMirasimDirectory(directory), false);
    fs.mkdirSync(path.join(directory, "resources"));
    fs.writeFileSync(path.join(directory, "resources", "app.asar"), "placeholder");
    assert.equal(isMirasimDirectory(directory), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("resolveInstallation honors an explicit complete directory", () => {
  const directory = makeDirectory();
  const unrelatedToolDirectory = makeDirectory();
  try {
    fs.mkdirSync(path.join(directory, "resources"));
    fs.writeFileSync(path.join(directory, "Mirasim.exe"), "placeholder");
    fs.writeFileSync(path.join(directory, "resources", "app.asar"), "placeholder");
    assert.equal(resolveInstallation(directory, unrelatedToolDirectory), fs.realpathSync.native(directory));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(unrelatedToolDirectory, { recursive: true, force: true });
  }
});

test("an invalid explicit directory never falls back to another installation", () => {
  const invalid = makeDirectory();
  const fallback = makeDirectory();
  try {
    fs.mkdirSync(path.join(fallback, "resources"));
    fs.writeFileSync(path.join(fallback, "Mirasim.exe"), "placeholder");
    fs.writeFileSync(path.join(fallback, "resources", "app.asar"), "placeholder");
    assert.throws(() => resolveInstallation(invalid, fallback), /--app does not point/);
  } finally {
    fs.rmSync(invalid, { recursive: true, force: true });
    fs.rmSync(fallback, { recursive: true, force: true });
  }
});
