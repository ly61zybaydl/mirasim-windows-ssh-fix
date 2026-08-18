# Contributing

Thank you for improving the Windows Remote SSH compatibility layer. This is an unofficial interoperability project; Mirasim itself is not part of this repository.

## Development setup

Requirements:

- Windows 10/11 x64 for apply/restore integration testing;
- Node.js 20 or newer;
- a user-owned installation of a supported Mirasim version;
- a disposable copy of that installation for tests that modify files.

```powershell
npm ci
npm test
npm run check
npm run build:askpass
```

The source repository omits the large runtime files listed in `assets/linux-compat/manifest.json`. The GitHub release workflow downloads or builds them and places them in the Windows ZIP. See [docs/RELEASE.md](docs/RELEASE.md).

## Contribution rules

- Never commit or upload `Mirasim.exe`, `app.asar`, extracted Mirasim bundles, server/web assets, or any other file copied from a Mirasim installation.
- Never commit a private key, token, credential, real SSH configuration, or an unsanitized log/screenshot.
- Use placeholders such as `example.invalid`, `203.0.113.10`, `<user>` and `C:\Users\<you>\.ssh\id_rsa` in documentation and tests.
- Do not add telemetry or upload SSH configuration. The patcher must not read private-key contents.
- Keep large compatibility binaries out of Git history; the release workflow adds them to the downloadable ZIP.

## Adding a Mirasim version

1. Inspect a legally obtained local installation without committing extracted proprietary content.
2. Update the patch rules for the new version.
3. Add source-only tests using synthetic/minimal fixtures.
4. Test `status`, `apply`, a second `apply`, `repair`, and `restore` against a disposable copy.
5. Run an opt-in remote connection test using environment variables; never hard-code a real host, IP, username or key path.
6. Document the supported version and platform limits.

Local-only compatibility tests accept `MIRASIM_FIXTURE_0170_MAIN`, `MIRASIM_FIXTURE_0203_MAIN`, `MIRASIM_FIXTURE_0205_ASAR`, `MIRASIM_FIXTURE_0208_ASAR`, and the corresponding `MIRASIM_FIXTURE_*_RENDERER` variables used by the renderer tests. CI leaves them unset; never add a private Mirasim fixture to the repository.

## Third-party changes

When a dependency or compatibility asset changes:

- review its license and redistribution terms;
- update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and any asset-local notice;
- keep upstream URLs in the relevant manifest;
- ensure release packaging retains dependency license files.

## Pull requests

Keep changes focused and include the commands you ran and their results. Redact environment-specific information, and do not attach proprietary fixtures or binary diffs from Mirasim.
