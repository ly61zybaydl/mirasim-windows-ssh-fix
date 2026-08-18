# Release Checklist

This project has two deliberately different distribution forms:

- the Git repository and GitHub-generated source archives contain reviewable source, scripts, manifests and notices, but no large compatibility binaries;
- the separately assembled Windows x64 Release ZIP adds the exact binary assets required by `apply` and `repair`.

Never describe a source archive as an end-user package.

## 1. Prepare a clean source tree

1. Confirm the intended version in `package.json` and review `package-lock.json`.
2. Confirm only explicitly supported Mirasim versions appear in the README and code allow list.
3. Search tracked files and pending changes for private endpoints, usernames, user-directory paths, credentials and SSH key material.
4. Confirm no Mirasim-copied files or extracted bundles are tracked.
5. Confirm the large patterns in `.gitignore` are not already present in Git history; ignore rules do not remove previously tracked files.

Useful preflight checks:

```powershell
npm ci
npm test
npm run check
git status --short
git ls-files | Select-String -Pattern 'Mirasim\.exe|app\.asar|id_rsa|id_ed25519|\.pem$|\.ppk$'
```

Review matches manually; a filename match is not by itself proof of a secret, and an empty result does not replace review.

## 2. Acquire or build release-only assets

Use `assets/linux-compat/manifest.json`, `assets/windows-runtime/manifest.json` and `assets/windows-askpass/manifest.json` as the authoritative file lists.

- Obtain the Node.js archive only from the recorded upstream URL.
- Build the `node-pty` binary from the recorded upstream source using the documented build script/environment.
- Do not download either file from an unreviewed mirror or contributor attachment.
- Verify every file's SHA-256 before packaging.
- Keep the large Linux Node.js archive, `node-pty` binary and Windows Node.js ZIP untracked; they must never be added to a source commit or source tag. The small first-party askpass executable is tracked beside its source and strict manifest.
- Obtain the pinned Windows Node.js ZIP only from `nodejs.org`, verify its recorded SHA-256, and extract only the runtime and its license into the end-user package. Never use the target `Mirasim.exe` as the patcher's runtime.
- Run `npm run build:askpass` on Windows. It compiles the reviewed C# source with the inbox .NET Framework compiler, normalizes the compiler's timestamp/MVID fields, and refuses output whose SHA-256 differs from the pinned manifest. Do not replace the helper with a contributor-supplied binary.

The legacy-runtime workflow additionally pins its Ubuntu 18.04 OCI index digest. Its build-only Miniconda installer is downloaded from the [official Anaconda index](https://repo.anaconda.com/miniconda/) and must match SHA-256 `807774bae6cd87132094458217ebf713df436f64779faf9bb4c3d4b6615c1e3a` before execution (`Miniconda3-py311_24.11.1-0-Linux-x86_64.sh`). These values were rechecked on 2026-08-18; update them only after reviewing the corresponding official source.

The `node-pty` binary includes/uses MIT-licensed `node-addon-api` headers. A complete release must retain [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), the asset-local notice, and dependency license files.

## 3. Assemble the Windows x64 ZIP

The package should include at least:

- `Mirasim-SSH-Fix.cmd`, `src/`, `scripts/`, `test/`, the production Node dependencies and `package.json`/lockfile;
- `runtime/node.exe`, `runtime/NODE_LICENSE.txt` and the pinned Windows runtime manifest;
- `assets/linux-compat/manifest.json` and every file marked `releaseAsset`;
- `assets/windows-askpass/manifest.json`, its verified `windows-askpass.exe`, and the corresponding `native/windows-askpass/Program.cs` source;
- `README.md`, `LICENSE`, `SECURITY.md` and `THIRD_PARTY_NOTICES.md`;
- third-party package license files.

It must not include:

- Mirasim binaries, `app.asar`, extracted Mirasim code, server/web assets or trademarks presented as this project's branding;
- test copies, backup directories, `.env` files, SSH configuration, private keys, real connection details or unsanitized logs;
- developer caches or Git metadata.

Name the package so it cannot be confused with GitHub's generated source ZIP, for example:

```text
mirasim-windows-ssh-fix-v<version>-win-x64.zip
```

## 4. Verify the assembled package

Test from a fresh extraction directory on Windows:

1. Run `status` against a disposable copy of every supported Mirasim version.
2. Run `apply`, then `status`, then a second `apply` to verify idempotence.
3. Remove one installed compatibility asset and verify `repair` restores it.
4. Run `restore` and compare `Mirasim.exe` and `app.asar` SHA-256 values with their originals.
5. Confirm an unknown version and a tampered patched file are refused.
6. Run opt-in remote integration tests using environment variables only; inspect all captured output for secrets before retention.
7. Test the ZIP on a machine/folder that does not have the source checkout or developer cache.
8. Run the native askpass special-character test on Windows and confirm its stdout and exit code reach the invoking OpenSSH process unchanged.

Generate and publish the ZIP's SHA-256 checksum. Inspect the final archive file list before attaching it to a release.

## 5. Workflow supply-chain controls

- Every external GitHub Action is referenced by its complete upstream commit SHA, with the human-readable release version retained in a comment. Review both the upstream repository and tag before changing either value.
- Every checkout sets `persist-credentials: false`; build and package jobs have only `contents: read` permission.
- Release builds use exact Node.js `22.23.1`; the broader CI matrix continues to exercise supported Node.js release lines.
- Only the tag-only `publish` job receives `contents: write`. Its OIDC and `attestations: write` permissions are limited to creating GitHub artifact provenance.
- Before publishing, the tag must match the single ZIP filename. The Windows-produced checksum sidecar is normalized to LF for cross-platform consumers, then `SHA256SUMS.txt` must verify successfully on the Linux publisher.
- Tagged ZIP and checksum files receive GitHub artifact attestations before the Release is created. After download, verify a release with:

```powershell
gh attestation verify .\mirasim-windows-ssh-fix-v<version>-win-x64.zip --repo <owner>/<repository>
```

The checksum and attestation are complementary: the checksum detects accidental corruption and the attestation binds the artifact digest to this repository's GitHub Actions identity.

## 6. Release notes

State clearly:

- this is an unofficial tool;
- exact supported Mirasim versions;
- official Mirasim updates overwrite the patch and require a compatible `repair`;
- users must download the complete Windows Release ZIP, not **Source code**;
- backup and restore are version/hash bound;
- no Mirasim files are redistributed;
- known limitations and any change to the old-Linux compatibility assets.

Do not claim a release is published until its attachment, checksum and fresh-install verification are all complete.
