# Release Guide

The Git repository contains source, scripts, manifests and notices. The separately built Windows x64 ZIP also contains the Windows Node.js runtime and the legacy Linux compatibility assets required by `apply` and `repair`.

Do not describe GitHub's automatically generated source archive as the end-user package.

## Prepare the source tree

1. Set the intended version in `package.json`.
2. Confirm the supported Mirasim versions in the README and code.
3. Review tracked and pending files for private endpoints, usernames, credentials, SSH keys and copied Mirasim files.
4. Run the project tests.

```powershell
npm ci
npm test
npm run check
git status --short
git ls-files | Select-String -Pattern 'Mirasim\.exe|app\.asar|id_rsa|id_ed25519|\.pem$|\.ppk$'
```

Review any matches manually.

## Build the Windows ZIP locally

The packaging script builds `windows-askpass.exe`, downloads the Windows Node.js runtime when it is missing, installs production dependencies and creates the ZIP:

```powershell
npm run package:win
```

Local packaging also needs these Linux compatibility files in `assets/linux-compat`:

- `node-v22.23.1-linux-x64-glibc-217.tar.xz`
- `pty-node-v127-glibc217.node`
- `install-legacy-runtime.sh`
- `THIRD_PARTY_NOTICES.txt`

The release workflow downloads the Linux Node.js archive and builds the `node-pty` binary automatically on Ubuntu 18.04.

The resulting file is:

```text
dist/mirasim-windows-ssh-fix-v<version>-win-x64.zip
```

## Build or publish with GitHub Actions

- Run **Release package** with `workflow_dispatch` to build a downloadable workflow artifact without publishing a GitHub Release.
- Push a `v*` tag to build the same package and publish the single Windows ZIP as a GitHub Release.
- Build jobs use read-only repository access. Only the tag publishing job receives `contents: write`.

## Package contents

The Windows ZIP includes:

- `Mirasim-SSH-Fix.cmd`, `src/`, `scripts/`, production Node dependencies and package metadata;
- `runtime/node.exe` and `runtime/NODE_LICENSE.txt`;
- the legacy Linux compatibility runtime and `node-pty` binary;
- `windows-askpass.exe` and its C# source;
- README, license, security and third-party notices.

It must not include:

- `Mirasim.exe`, `app.asar`, extracted Mirasim code or server/web assets;
- SSH configuration, private keys, real connection details or credentials;
- test copies, backups, developer caches or Git metadata.

## Functional test

Test a fresh extraction on Windows:

1. Run `status` against a disposable copy of each supported Mirasim version.
2. Run `apply`, then `status`, then `apply` again.
3. Remove one installed compatibility asset and confirm `repair` restores it.
4. Run `restore` and confirm the disposable installation starts normally.
5. Run an opt-in remote SSH connection test using environment variables only.
6. Test the native askpass helper with prompt text containing quotes, percent signs and exclamation marks.

## Release notes

State clearly:

- this is an unofficial tool;
- which Mirasim versions are supported;
- a Mirasim update can overwrite the patch and may require `repair`;
- users must download the Windows Release ZIP, not **Source code**;
- no Mirasim files are redistributed;
- known platform limits.

Do not claim the release is published until the ZIP appears on the GitHub Release page and has been tested from a fresh extraction.
