"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { sha256File } = require("../src/util.cjs");
const { verifyAssetDirectory } = require("../scripts/verify-release-assets.cjs");

const root = path.resolve(__dirname, "..");
const assetDirectory = path.join(root, "assets", "windows-askpass");
const manifestPath = path.join(assetDirectory, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

test("Windows askpass source and executable match their strict manifest", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.target, "windows-x64");
  assert.equal(manifest.source.path, "native/windows-askpass/Program.cs");
  assert.match(manifest.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    sha256File(path.join(root, ...manifest.source.path.split("/"))),
    manifest.source.sha256,
  );

  const result = verifyAssetDirectory(assetDirectory, manifestPath);
  assert.equal(result.target, "windows-x64");
  assert.deepEqual(result.files.map((file) => file.name), ["windows-askpass.exe"]);
});

test(
  "native Windows askpass forwards special characters without shell interpretation",
  { skip: process.platform !== "win32" ? "requires Windows" : false },
  () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirasim askpass 测试-"));
    try {
      const resourcesDirectory = path.join(temporaryRoot, "resources");
      const shimDirectory = path.join(resourcesDirectory, "mirasim-ssh-fix");
      fs.mkdirSync(shimDirectory, { recursive: true });
      fs.copyFileSync(process.execPath, path.join(temporaryRoot, "Mirasim.exe"));
      const shimPath = path.join(shimDirectory, "windows-askpass.exe");
      fs.copyFileSync(path.join(assetDirectory, "windows-askpass.exe"), shimPath);
      fs.writeFileSync(
        path.join(resourcesDirectory, "askpass.cjs"),
        '"use strict"; process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
        "utf8",
      );

      const prompts = [
        "",
        "Password for user@example.invalid:",
        'spaces "quotes" and trailing slash\\',
        "%PATH% !bang! ^caret^ &and|pipe <in>out (parentheses)",
        "反斜杠\\、空格 与 Unicode 🔐\r\nsecond line",
      ];
      for (const prompt of prompts) {
        const result = childProcess.spawnSync(shimPath, [prompt], {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), [prompt]);
      }
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);
