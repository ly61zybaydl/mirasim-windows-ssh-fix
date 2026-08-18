"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const ResEdit = require("resedit");

const RESOURCE_TYPE = "INTEGRITY";
const RESOURCE_ID = "ELECTRONASAR";
const APP_ASAR_RESOURCE_PATH = "resources\\app.asar";

function asarHeaderHash(asarPath) {
  const { headerString } = asar.getRawHeader(asarPath);
  return crypto.createHash("sha256").update(headerString).digest("hex");
}

function parseExecutable(buffer, allowSignedOutput) {
  try {
    return { executable: ResEdit.NtExecutable.from(buffer), wasSigned: false };
  } catch (error) {
    if (!allowSignedOutput) {
      throw new Error(`Mirasim.exe appears to contain an Authenticode certificate. Refusing to invalidate it: ${error.message}`);
    }
    return { executable: ResEdit.NtExecutable.from(buffer, { ignoreCert: true }), wasSigned: true };
  }
}

function resourceLanguage(resource) {
  const existing = resource.getResourceEntriesAsString(RESOURCE_TYPE, RESOURCE_ID);
  if (existing.length > 0) return existing[0][0];
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resource.entries);
  if (versions.length === 1) {
    const languages = versions[0].getAllLanguagesForStringValues();
    if (languages.length === 1) return languages[0].lang;
  }
  return 1033;
}

function readIntegrityListsFromResource(resource) {
  return resource.getResourceEntriesAsString(RESOURCE_TYPE, RESOURCE_ID).map(([language, value]) => {
    let entries;
    try {
      entries = JSON.parse(value);
    } catch (error) {
      throw new Error(`Mirasim.exe contains malformed Electron ASAR integrity metadata: ${error.message}`);
    }
    if (!Array.isArray(entries)) throw new Error("Electron ASAR integrity metadata is not an array");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
          typeof entry.file !== "string" || typeof entry.alg !== "string" || typeof entry.value !== "string") {
        throw new Error("Electron ASAR integrity metadata contains an invalid entry");
      }
    }
    return { language, entries };
  });
}

function updateEntryList(entries, hash) {
  const result = entries.map((entry) => ({ ...entry }));
  const normalizedTarget = path.win32.normalize(APP_ASAR_RESOURCE_PATH).toLowerCase();
  let found = 0;
  for (const entry of result) {
    if (typeof entry.file === "string" && path.win32.normalize(entry.file).toLowerCase() === normalizedTarget) {
      entry.file = APP_ASAR_RESOURCE_PATH;
      entry.alg = "SHA256";
      entry.value = hash;
      found += 1;
    }
  }
  if (found > 1) throw new Error("Electron ASAR integrity metadata contains duplicate app.asar entries");
  if (found === 0) result.push({ file: APP_ASAR_RESOURCE_PATH, alg: "SHA256", value: hash });
  return result;
}

function readExeIntegrity(exePath, allowSignedOutput = false) {
  const buffer = fs.readFileSync(exePath);
  const { executable, wasSigned } = parseExecutable(buffer, allowSignedOutput);
  const resource = ResEdit.NtExecutableResource.from(executable);
  return { wasSigned, lists: readIntegrityListsFromResource(resource) };
}

function buildExeWithUpdatedIntegrity(exePath, asarPath, allowSignedOutput = false) {
  const buffer = fs.readFileSync(exePath);
  const { executable, wasSigned } = parseExecutable(buffer, allowSignedOutput);
  const resource = ResEdit.NtExecutableResource.from(executable);
  const existing = readIntegrityListsFromResource(resource);
  const hash = asarHeaderHash(asarPath);
  const updatedLists = existing.length > 0
    ? existing.map((item) => ({ language: item.language, entries: updateEntryList(item.entries, hash) }))
    : [{ language: resourceLanguage(resource), entries: updateEntryList([], hash) }];
  resource.removeResourceEntry(RESOURCE_TYPE, RESOURCE_ID);
  for (const item of updatedLists) {
    resource.replaceResourceEntryFromString(
      RESOURCE_TYPE,
      RESOURCE_ID,
      item.language,
      JSON.stringify(item.entries),
    );
  }
  resource.outputResource(executable);
  const generated = Buffer.from(executable.generate());

  const verificationExe = ResEdit.NtExecutable.from(generated);
  const verificationResource = ResEdit.NtExecutableResource.from(verificationExe);
  const verificationLists = readIntegrityListsFromResource(verificationResource);
  if (verificationLists.length !== updatedLists.length) throw new Error("Generated Mirasim.exe lost an ASAR integrity resource language");
  for (const list of verificationLists) {
    const appEntries = list.entries.filter((entry) =>
      path.win32.normalize(entry.file).toLowerCase() === path.win32.normalize(APP_ASAR_RESOURCE_PATH).toLowerCase());
    if (appEntries.length !== 1 || appEntries[0].alg !== "SHA256" || appEntries[0].value !== hash) {
      throw new Error("Generated Mirasim.exe failed the ASAR integrity metadata verification");
    }
  }
  return { buffer: generated, headerHash: hash, wasSigned, lists: updatedLists };
}

module.exports = {
  APP_ASAR_RESOURCE_PATH,
  asarHeaderHash,
  buildExeWithUpdatedIntegrity,
  readExeIntegrity,
};
