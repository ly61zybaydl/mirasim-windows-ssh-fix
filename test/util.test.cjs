"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertPathInside,
  normalizePathForComparison,
  sha256Buffer,
  sha256File,
  writeJsonAtomic,
} = require("../src/util.cjs");

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim-fix-test-"));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("SHA-256 helpers return the expected digest", () => withTemporaryDirectory((directory) => {
  const data = Buffer.from("public test fixture\n", "utf8");
  const expected = "bcccd83d73a6110f93dc18eca2c44ed963896a55f180dd5ff74b4c62dd2b2c81";
  const filePath = path.join(directory, "fixture.txt");
  fs.writeFileSync(filePath, data);
  assert.equal(sha256Buffer(data), expected);
  assert.equal(sha256File(filePath), expected);
}));

test("writeJsonAtomic leaves valid formatted JSON and no temporary file", () => withTemporaryDirectory((directory) => {
  const filePath = path.join(directory, "nested", "state.json");
  writeJsonAtomic(filePath, { version: 1, safe: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { version: 1, safe: true });
  assert.match(fs.readFileSync(filePath, "utf8"), /\n$/);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ["state.json"]);
}));

test("path containment accepts descendants and refuses siblings", () => withTemporaryDirectory((directory) => {
  const child = path.join(directory, "backups", "one");
  assert.doesNotThrow(() => assertPathInside(directory, child, "backup"));
  assert.throws(
    () => assertPathInside(path.join(directory, "app"), path.join(directory, "app-copy"), "backup"),
    /outside the expected directory/,
  );
  assert.equal(
    normalizePathForComparison(`${directory}${path.sep}`),
    normalizePathForComparison(directory),
  );
}));
