"use strict";

const path = require("node:path");

function normalizePathForComparison(value) {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

module.exports = {
  normalizePathForComparison,
};
