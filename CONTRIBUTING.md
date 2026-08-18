# Contributing

Thank you for improving the Windows Remote SSH compatibility layer. This is an unofficial interoperability project, so changes must keep a strict boundary between our patcher and Mirasim's software.

## Development setup

Requirements:

- Windows 10/11 x64 for apply/restore integration testing;
- Node.js 20 or newer;
- a legally obtained, user-owned installation of a supported Mirasim version;
- a disposable test copy of that installation for mutation tests.

```powershell
npm ci
npm test
npm run check
```

The source tree intentionally omits the large binary files marked `releaseAsset` in `assets/linux-compat/manifest.json`. Source-only tests should not require them. For release or end-to-end testing, acquire/build them using their documented upstream sources, verify every SHA-256 value against the manifest, and keep them untracked. See [docs/RELEASE.md](docs/RELEASE.md).

## Contribution rules

- Never commit or upload `Mirasim.exe`, `app.asar`, extracted Mirasim source/bundles, Mirasim server/web assets, or any other file copied from a Mirasim installation.
- Never commit a private key, `.env` file, SSH agent export, real SSH configuration, token, credential or unsanitized log/screenshot.
- Use placeholders such as `example.invalid`, `203.0.113.10`, `<user>` and `C:\Users\<you>\.ssh\id_rsa` in documentation and tests.
- Do not add telemetry or upload SSH configuration. The patcher must not read private-key contents.
- Keep mutation operations fail-closed: verify inputs, stage changes, verify outputs and preserve rollback behavior.
- Preserve version- and hash-bound backup/restore checks. A `--force` path that bypasses version, identity or hash checks is not acceptable.
- Keep large compatibility binaries out of Git history. They belong only in a separately assembled Release ZIP.

## Adding a Mirasim version

Do not add a version to the allow list based only on its version string.

1. Inspect a legally obtained local installation without committing any extracted proprietary content.
2. Confirm each semantic patch target occurs exactly as expected.
3. Add source-only tests that use synthetic/minimal fixtures or hashes, not copied Mirasim code.
4. Test `status`, `apply`, idempotent re-apply, `repair`, failure rollback and `restore` against a disposable copy.
5. Verify the restored `Mirasim.exe` and `app.asar` hashes equal the originals.
6. Run an opt-in end-to-end test using environment variables for target details; never hard-code a real host, IP, username or key path.
7. Document the newly supported version and any narrower platform limits.

Local-only compatibility tests accept `MIRASIM_FIXTURE_0170_MAIN`, `MIRASIM_FIXTURE_0203_MAIN`, and `MIRASIM_FIXTURE_0205_ASAR`. CI intentionally leaves them unset; never add a private Mirasim fixture to the repository.

## Third-party changes

When a dependency or compatibility asset changes:

- review its license and redistribution terms;
- update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and any asset-local notice;
- recompute and review `assets/linux-compat/manifest.json` hashes;
- ensure release packaging retains dependency license files;
- do not replace an upstream URL with an opaque binary download.

## Pull requests

Keep changes focused and explain the safety properties they preserve. Include commands run and their results, but redact all environment-specific information. A pull request must not attach proprietary fixtures or binary diffs from Mirasim.
