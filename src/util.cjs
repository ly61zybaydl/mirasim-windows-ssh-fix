"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const size = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (size === 0) break;
      hash.update(chunk.subarray(0, size));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw error;
  }
}

function normalizePathForComparison(value) {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function assertPathInside(parentPath, childPath, label) {
  const parent = `${normalizePathForComparison(parentPath)}${path.sep}`;
  const child = normalizePathForComparison(childPath);
  if (!child.startsWith(parent)) {
    throw new Error(`${label} is outside the expected directory: ${childPath}`);
  }
}

module.exports = {
  assertPathInside,
  normalizePathForComparison,
  sha256Buffer,
  sha256File,
  writeJsonAtomic,
};
