"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { normalizePathForComparison } = require("../src/util.cjs");

test("path normalization removes a trailing separator", () => {
  const directory = path.join("C:", "example", "app");
  assert.equal(
    normalizePathForComparison(`${directory}${path.sep}`),
    normalizePathForComparison(directory),
  );
});
