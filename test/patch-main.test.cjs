"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const asar = require("@electron/asar");
const {
  BRIDGE_PATCH_MARKER,
  PATCH_MARKER,
  TESTED_VERSIONS,
  hasNativeWindowsRemoteSsh,
  isMainPatchCurrent,
  patchMainSource,
  verifyPatchedSource,
} = require("../src/patch-main.cjs");

const NATIVE_PLAIN_TUNNEL = /\['forward'\]\(([\w$]+),([\w$]+)\)\{let\s+[\w$]+=\['-N','-L','127\.0\.0\.1:'\+\1\+':'\+\2,'-oExitOnForwardFailure=(yes|no)'/;

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function nativePlainTunnelMatch(source) {
  const matches = [...source.matchAll(new RegExp(NATIVE_PLAIN_TUNNEL.source, "g"))];
  assert.equal(matches.length, 1);
  return matches[0];
}

function replaceNativePlainTunnelPolicy(source, policy) {
  const match = nativePlainTunnelMatch(source);
  const current = `'-oExitOnForwardFailure=${match[3]}'`;
  const offset = match.index + match[0].lastIndexOf(current);
  assert.ok(offset >= match.index);
  return source.slice(0, offset) +
    `'-oExitOnForwardFailure=${policy}'` +
    source.slice(offset + current.length);
}

test("the versions exercised by fixtures are listed", () => {
  assert.deepEqual([...TESTED_VERSIONS].sort(), ["0.0.170", "0.0.203", "0.0.205", "0.0.208", "0.0.214"]);
});

test("patched-source verification fails closed for a public synthetic snippet", () => {
  assert.throws(() => verifyPatchedSource('"use strict"; void 0;'), /is missing/);
});

test("unknown Mirasim versions are attempted through semantic anchors", () => {
  assert.throws(
    () => patchMainSource("synthetic source", "9.9.9"),
    (error) => {
      assert.doesNotMatch(error.message, /not supported|version/i);
      assert.match(error.message, /expected marker was not found/);
      return true;
    },
  );
});

test("a synthetic source fails because required semantic anchors are absent", () => {
  assert.throws(
    () => patchMainSource('"use strict"; void 0;', "0.0.203"),
    /expected marker was not found/,
  );
});

test("main patch status rejects the previous Windows tunnel policy", () => {
  const runtimePatch = `${PATCH_MARKER} async function __mirasimEnsureLegacyLinuxRuntime(){} let __mirasimLegacyInstalled=await __mirasimEnsureLegacyLinuxRuntime(x); __mirasimMinor<17 `;
  const prefix = `${runtimePatch} ${BRIDGE_PATCH_MARKER} `;
  const current = `${prefix}__mirasimTunnelArgs=['-N','-oClearAllForwardings=no','-oExitOnForwardFailure=no'`;
  const previous = `${prefix}__mirasimTunnelArgs=['-N','-oClearAllForwardings=no','-oExitOnForwardFailure=yes'`;
  assert.equal(isMainPatchCurrent(current), true);
  assert.equal(isMainPatchCurrent(previous), false);
  const legacyArchitecture = `${runtimePatch} __mirasimTunnelArgs=['-N','-oClearAllForwardings=no','-oExitOnForwardFailure=no'`;
  assert.equal(isMainPatchCurrent(legacyArchitecture), true);
  const bridgeGuardWithoutPatch = `${legacyArchitecture} process['stdout']['write']('[remote-ssh]\\x20not\\x20supported\\x20on\\x20win32`;
  assert.equal(isMainPatchCurrent(bridgeGuardWithoutPatch), false);
});

test("native Windows SSH status requires the legacy runtime patch and current plain tunnel policy", () => {
  const nativeSource = String.raw`
    ${PATCH_MARKER}
    async function __mirasimEnsureLegacyLinuxRuntime(){}
    let __mirasimLegacyInstalled=await __mirasimEnsureLegacyLinuxRuntime(master);
    __mirasimMinor<17;
    this['opts']['transport']??(process['platform']==='win32'?'plain':'mux');
    return platform==='win32'?'\x5c\x5c.\x5cpipe\x5cmirasim-askpass-'+token:'socket';
    return platform==='win32'?'ssh-askpass-wrapper.bat':'ssh-askpass-wrapper.sh';
    'askpass.bat';
    'ssh-add-askpass.bat';
    ['forward'](localPort,remoteSocket){let args=['-N','-L','127.0.0.1:'+localPort+':'+remoteSocket,'-oExitOnForwardFailure=no'];}
  `;
  assert.equal(hasNativeWindowsRemoteSsh(nativeSource), true);
  assert.equal(isMainPatchCurrent(nativeSource), true);
  assert.equal(isMainPatchCurrent(nativeSource.replace("let __mirasimLegacyInstalled=", "let legacyRuntimeMissing=")), false);
  const previousPolicy = replaceNativePlainTunnelPolicy(nativeSource, "yes");
  assert.equal(hasNativeWindowsRemoteSsh(previousPolicy), true);
  assert.equal(isMainPatchCurrent(previousPolicy), false);
});

for (const [version, environmentName] of [
  ["0.0.170", "MIRASIM_FIXTURE_0170_MAIN"],
  ["0.0.203", "MIRASIM_FIXTURE_0203_MAIN"],
  ["0.0.205", "MIRASIM_FIXTURE_0205_ASAR"],
  ["0.0.208", "MIRASIM_FIXTURE_0208_ASAR"],
  ["0.0.214", "MIRASIM_FIXTURE_0214_ASAR"],
]) {
  const fixturePath = process.env[environmentName];
  test(`optional local ${version} main bundle patches and is idempotent`, {
    skip: fixturePath ? false : `set ${environmentName} to run this local-only compatibility test`,
  }, () => {
    const original = environmentName.endsWith("_ASAR")
      ? asar.extractFile(fixturePath, "dist/main.cjs").toString("utf8")
      : fs.readFileSync(fixturePath, "utf8");
    const nativeWindows = hasNativeWindowsRemoteSsh(original);
    const first = patchMainSource(original, version);
    assert.equal(first.alreadyPatched, false);
    assert.equal(isMainPatchCurrent(first.source), true);
    verifyPatchedSource(first.source);
    const futureVersion = patchMainSource(original, "99.0.0");
    assert.equal(futureVersion.alreadyPatched, false);
    assert.equal(futureVersion.source, first.source);
    const second = patchMainSource(first.source, version);
    assert.equal(second.alreadyPatched, true);
    assert.equal(second.source, first.source);

    const currentTunnelPolicy = "__mirasimTunnelArgs=['-N','-oClearAllForwardings=no','-oExitOnForwardFailure=no'";
    if (first.source.includes(currentTunnelPolicy)) {
      const previousPolicy = first.source.replace(
        currentTunnelPolicy,
        "__mirasimTunnelArgs=['-N','-oClearAllForwardings=no','-oExitOnForwardFailure=yes'",
      );
      assert.equal(isMainPatchCurrent(previousPolicy), false);
      const migrated = patchMainSource(previousPolicy, version);
      assert.equal(migrated.alreadyPatched, false);
      assert.equal(isMainPatchCurrent(migrated.source), true);
      assert.equal(migrated.source, first.source);

      if (first.source.includes(BRIDGE_PATCH_MARKER)) {
        const previousRelease = previousPolicy.replace(
          `if(false/*${BRIDGE_PATCH_MARKER}*/)`,
          "if(process['platform']==='win32')",
        );
        assert.equal(previousRelease.includes(PATCH_MARKER), true);
        assert.equal(previousRelease.includes(BRIDGE_PATCH_MARKER), false);
        const fullyMigrated = patchMainSource(previousRelease, version);
        assert.equal(fullyMigrated.alreadyPatched, false);
        assert.equal(fullyMigrated.source, first.source);
        assert.equal(patchMainSource(fullyMigrated.source, version).alreadyPatched, true);
      }
    }

    const hookStart = first.source.indexOf("let __mirasimLegacyInstalled=await __mirasimEnsureLegacyLinuxRuntime(");
    const hookEnd = first.source.indexOf(";let ", hookStart);
    assert.ok(hookStart >= 0 && hookEnd > hookStart);
    const missingHook = first.source.slice(0, hookStart) + "let " + first.source.slice(hookEnd + 5);
    assert.equal(isMainPatchCurrent(missingHook), false);
    const hookRepaired = patchMainSource(missingHook, version);
    assert.equal(hookRepaired.alreadyPatched, false);
    assert.equal(hookRepaired.source, first.source);

    if (nativeWindows) {
      assert.equal(["0.0.208", "0.0.214"].includes(version), true);
      assert.equal(nativePlainTunnelMatch(original)[3], "yes");
      assert.equal(nativePlainTunnelMatch(first.source)[3], "no");
      assert.equal(
        countOccurrences(first.source, "-oExitOnForwardFailure=yes"),
        countOccurrences(original, "-oExitOnForwardFailure=yes") - 1,
      );
      assert.equal(
        countOccurrences(first.source, "-oExitOnForwardFailure=no"),
        countOccurrences(original, "-oExitOnForwardFailure=no") + 1,
      );
      const previousNativePolicy = replaceNativePlainTunnelPolicy(first.source, "yes");
      assert.equal(hasNativeWindowsRemoteSsh(previousNativePolicy), true);
      assert.equal(isMainPatchCurrent(previousNativePolicy), false);
      const migratedNativePolicy = patchMainSource(previousNativePolicy, version);
      assert.equal(migratedNativePolicy.alreadyPatched, false);
      assert.equal(migratedNativePolicy.source, first.source);
      assert.equal(patchMainSource(migratedNativePolicy.source, version).alreadyPatched, true);
      for (const legacyWindowsMarker of [
        "windows-askpass.exe",
        "__mirasimProbeAskpassPath",
        "__mirasimSshAddAskpassPath",
        "__mirasimWindowsAskpassServer",
        "__mirasimTunnelChild",
      ]) {
        assert.equal(first.source.includes(legacyWindowsMarker), false);
      }
    }
  });
}
