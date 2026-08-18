"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");
const { normalizePathForComparison } = require("./util.cjs");

function isMirasimDirectory(candidate) {
  if (!candidate) return false;
  return fs.existsSync(path.join(candidate, "Mirasim.exe")) &&
    fs.existsSync(path.join(candidate, "resources", "app.asar"));
}

function registryCandidates() {
  if (process.platform !== "win32") return [];
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const results = [];
  for (const root of roots) {
    let output = "";
    try {
      output = execFileSync("reg.exe", ["query", root, "/s", "/f", "Mirasim"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:DisplayIcon|InstallLocation|UninstallString)\s+REG_\w+\s+(.+)$/i);
      if (!match) continue;
      const raw = match[1].trim().replace(/^"|"$/g, "");
      const exeIndex = raw.toLowerCase().indexOf("mirasim.exe");
      const value = exeIndex >= 0 ? raw.slice(0, exeIndex + "mirasim.exe".length) : raw;
      const candidate = value.toLowerCase().endsWith(".exe") ? path.dirname(value) : value;
      results.push(candidate);
    }
  }
  return results;
}

function resolveInstallation(explicitPath, toolDirectory = path.resolve(__dirname, "..")) {
  const canonicalCandidate = (candidate) => {
    if (!candidate) return null;
    let resolved;
    try {
      resolved = path.resolve(candidate);
    } catch {
      return null;
    }
    if (!isMirasimDirectory(resolved)) return null;
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };

  if (explicitPath) {
    const explicit = canonicalCandidate(explicitPath);
    if (!explicit) {
      throw new Error(`--app does not point to a complete Mirasim directory: ${path.resolve(explicitPath)}`);
    }
    return explicit;
  }

  const candidates = [];
  candidates.push(toolDirectory);
  if (process.platform === "win32") {
    candidates.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "@mirasimdesktop"));
    candidates.push(...registryCandidates());
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = canonicalCandidate(candidate);
    if (!resolved) continue;
    const key = normalizePathForComparison(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    return resolved;
  }
  throw new Error("Mirasim was not found. Pass --app <directory>, or place the tool beside Mirasim.exe for a portable copy.");
}

function inspectPackage(installDirectory) {
  const exePath = path.join(installDirectory, "Mirasim.exe");
  const asarPath = path.join(installDirectory, "resources", "app.asar");
  if (!isMirasimDirectory(installDirectory)) {
    throw new Error(`Not a complete Mirasim directory: ${installDirectory}`);
  }
  let packageJson;
  try {
    packageJson = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
  } catch (error) {
    throw new Error(`Could not read package.json from app.asar: ${error.message}`);
  }
  if (packageJson.name !== "@mirasim/desktop" || typeof packageJson.version !== "string") {
    throw new Error("The selected app.asar is not a recognized official Mirasim desktop package.");
  }
  return { installDirectory, exePath, asarPath, packageJson };
}

module.exports = { inspectPackage, isMirasimDirectory, resolveInstallation };
