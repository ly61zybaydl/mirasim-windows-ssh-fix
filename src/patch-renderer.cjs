"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RENDERER_PATCH_MARKER = "__MIRASIM_WINDOWS_REMOTE_SSH_FRONTEND_PATCH_V1__";

const PLATFORM_GATE = /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return\s+\2\s*!==\s*["']win32["']\}/g;

function platformGates(source) {
  return [...source.matchAll(PLATFORM_GATE)].filter((match) => {
    const functionName = match[1];
    return source.includes(`if(!${functionName}(`) &&
      source.includes(`sshUnsupported:!${functionName}(`);
  });
}

function analyzeRendererSource(source) {
  const hasRemoteSshBridge = source.includes("remoteSsh:{") || source.includes('"remoteSsh":{');
  const applicable = hasRemoteSshBridge && source.includes('"conn.ssh.title"');
  const gates = applicable ? platformGates(source) : [];
  const patched = source.includes(RENDERER_PATCH_MARKER);
  const unsupportedUi = source.includes('"data-testid":"ssh-unsupported"') ||
    source.includes('"conn.remote.sshUnsupported"');
  const locked = applicable && (gates.length > 0 || (unsupportedUi && !patched));
  return {
    applicable,
    patched,
    locked,
    unlocked: applicable && !locked,
    gateCount: gates.length,
  };
}

function patchRendererSource(originalSource) {
  const before = analyzeRendererSource(originalSource);
  if (!before.applicable || before.unlocked) {
    return {
      source: originalSource,
      changed: false,
      alreadyUnlocked: before.unlocked,
      status: before,
    };
  }
  if (before.gateCount !== 1) {
    throw new Error(`Windows renderer gate: expected one semantic match, found ${before.gateCount}`);
  }

  const gate = platformGates(originalSource)[0];
  const replacement = `function ${gate[1]}(${gate[2]}){return!0}`;
  const patchedSource = `/*${RENDERER_PATCH_MARKER}*/` +
    originalSource.slice(0, gate.index) + replacement +
    originalSource.slice(gate.index + gate[0].length);
  return {
    source: patchedSource,
    changed: true,
    alreadyUnlocked: false,
    status: analyzeRendererSource(patchedSource),
  };
}

function rendererBundlePaths(extractedAppDirectory) {
  const assetsDirectory = path.join(extractedAppDirectory, "dist", "renderer", "assets");
  if (!fs.existsSync(assetsDirectory)) return [];
  return fs.readdirSync(assetsDirectory)
    .filter((name) => /^index-.*\.js$/.test(name))
    .sort()
    .map((name) => path.join(assetsDirectory, name));
}

function rendererBundleEntries(packageEntries) {
  return packageEntries
    .map((entry) => entry.replace(/^[/\\]/, ""))
    .filter((entry) => /^dist[/\\]renderer[/\\]assets[/\\]index-.*\.js$/.test(entry))
    .sort();
}

function analyzeRendererSources(sources) {
  const files = sources.map((item) => ({
    path: item.path,
    ...analyzeRendererSource(item.source),
  }));
  const applicable = files.filter((file) => file.applicable);
  return {
    files,
    applicable: applicable.length > 0,
    patched: applicable.some((file) => file.patched),
    locked: applicable.some((file) => file.locked),
    unlocked: applicable.length > 0 && applicable.every((file) => file.unlocked),
  };
}

function analyzeRendererFiles(filePaths) {
  return analyzeRendererSources(filePaths.map((filePath) => ({
    path: filePath,
    source: fs.readFileSync(filePath, "utf8"),
  })));
}

function patchRendererDirectory(extractedAppDirectory) {
  const filePaths = rendererBundlePaths(extractedAppDirectory);
  const changedFiles = [];
  for (const filePath of filePaths) {
    const result = patchRendererSource(fs.readFileSync(filePath, "utf8"));
    if (!result.changed) continue;
    fs.writeFileSync(filePath, result.source, "utf8");
    changedFiles.push(filePath);
  }
  return {
    ...analyzeRendererFiles(filePaths),
    changedFiles,
  };
}

module.exports = {
  RENDERER_PATCH_MARKER,
  analyzeRendererFiles,
  analyzeRendererSource,
  analyzeRendererSources,
  patchRendererDirectory,
  patchRendererSource,
  rendererBundleEntries,
  rendererBundlePaths,
};
