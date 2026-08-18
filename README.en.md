# Mirasim Windows Remote SSH Fix

[简体中文](README.md) | **English**

An unofficial compatibility patcher that enables Mirasim Remote SSH on Windows. It supports applying, repairing, and restoring the patch.

> [!IMPORTANT]
> This is a community-maintained **unofficial tool**. It is not affiliated with or endorsed by Mirasim. The tool backs up and modifies `resources/app.asar` in the local Mirasim installation and the active `%USERPROFILE%\.mirasim\app\<version>\renderer` runtime frontend. It does not modify `Mirasim.exe`. Fully exit Mirasim before using the tool and evaluate the risks for your environment.

## Tested configurations

| Component | Tested support |
| --- | --- |
| Local operating system | Windows 10/11 x64 |
| Mirasim Desktop | `0.0.170`, `0.0.203`, `0.0.205` |
| Downloaded Mirasim UI runtime | `0.0.207` |
| Remote operating system | Linux x86_64; the legacy runtime was verified on Ubuntu 18.04 x64 / glibc 2.27 |
| SSH client | Windows OpenSSH (`ssh.exe` / `scp.exe`) |

The versions above have been tested directly. The patcher also attempts other Mirasim Desktop versions when they retain a compatible internal structure. If the structure has changed, it reports the part it could not match.

## What it fixes

The Windows build of Mirasim Desktop blocks Remote SSH through its frontend entry point, Electron IPC bridge, and several main-process implementations that assume a Unix environment. This tool enables the SSH host-management interface and patches IPC registration, Windows platform restrictions, SSH askpass, port forwarding, `scp`, and process termination. It also includes a compatibility runtime for older glibc-based Linux x86_64 hosts.

The Windows askpass helper is a small native launcher built from source in this repository. It does not pass prompts through `cmd.exe`, so quotes, percent signs, exclamation marks, and similar characters are not interpreted a second time by a shell.

Before modifying anything, the patcher backs up the original `app.asar` and any active downloaded UI-runtime frontend file that needs to change. Use `restore` to restore backups created by the tool.

## Download and usage

### Regular users: use the complete Release ZIP

The complete Release ZIP contains a standalone Windows Node.js runtime, the legacy Linux compatibility runtime, and `windows-askpass.exe`. GitHub's automatically generated **Source code (zip/tar.gz)** archives do not contain these large runtime assets. Regular users should download the Windows ZIP attached to a release.

1. Download the complete Windows x64 ZIP from [Releases](https://github.com/ly61zybaydl/mirasim-windows-ssh-fix/releases) and extract it to a normal directory.
2. Fully exit Mirasim, including any instance still running in the background.
3. Double-click `Mirasim-SSH-Fix.cmd`. With no arguments, it runs `apply` by default.
4. Run `status` once afterward to confirm that the patch and compatibility assets are installed.

Common commands:

```bat
Mirasim-SSH-Fix.cmd status
Mirasim-SSH-Fix.cmd apply
Mirasim-SSH-Fix.cmd repair
Mirasim-SSH-Fix.cmd restore
```

If you previously used `v0.1.0` or `v0.1.1`, download `v0.1.2` or later, fully exit Mirasim, run `Mirasim-SSH-Fix.cmd repair`, and then restart Mirasim. Version `v0.1.2` patches the downloaded UI runtime that Mirasim actually loads, starts the Windows IPC bridge, and prevents an unrelated `RemoteForward` failure in `.ssh/config` from causing an endless reconnect loop. You do not need to clear any cache. Mirasim's “Restart Server” action alone does not reload the Electron bridge.

The unrelated `RemoteForward` may still produce an OpenSSH warning. The patch keeps Mirasim's required local tunnel alive; it does not make that remote forward succeed.

For a non-default installation directory:

```bat
Mirasim-SSH-Fix.cmd status --app "D:\Apps\Mirasim"
Mirasim-SSH-Fix.cmd apply --app "D:\Apps\Mirasim"
```

Administrator privileges are normally unnecessary, but Windows may require them if the selected installation directory is protected. The complete Release ZIP uses its bundled Node.js runtime. Running from source requires Node.js 20 or later.

### Developers: run from source

Node.js 20 or later is required:

```powershell
npm ci
npm test
npm run build:askpass
node src/cli.cjs status
```

`npm run build:askpass` uses the .NET Framework C# compiler included with Windows to rebuild the launcher from [`native/windows-askpass/Program.cs`](native/windows-askpass/Program.cs). A source checkout does not include the large files marked as `releaseAsset` in the manifests, so it is intended for development. The release workflow creates the complete distributable package. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/RELEASE.md](docs/RELEASE.md), and never commit files taken from Mirasim itself.

## Commands

- `status` / `detect`: report the installation directory, version, patch state, and compatibility-asset state. Add `--json` for JSON output.
- `apply`: create external backups and apply the patch.
- `repair`: reapply changes after an official update overwrites the patch. If the code patch remains but helper assets are missing, it refreshes only those assets.
- `restore`: restore original files from backups created by the tool.

## Will a Mirasim update overwrite the patch?

**Yes.** The Windows installer normally replaces the application directory, and Mirasim can download a new UI runtime separately. An update may therefore replace `resources/app.asar`, the active runtime frontend, or compatibility assets installed by this tool. The patcher and its external backups normally remain available.

After an update:

1. Exit Mirasim.
2. Run `status` with the latest patcher.
3. Run `repair`. The tool attempts the same semantic patch on an untested new version.
4. If the internal structure has changed, `repair` reports the unmatched location. Open an issue with sanitized error details so the version can be adapted.

## Backup and restore behavior

Default backup locations:

```text
%LOCALAPPDATA%\MirasimRemoteSshPatcher\backups\<Mirasim-version>\app.asar
%LOCALAPPDATA%\MirasimRemoteSshPatcher\backups\runtime\<runtime-version>\renderer\...
```

The state file is stored at `%LOCALAPPDATA%\MirasimRemoteSshPatcher\state.json`.

- A successful restore does not delete the external backups automatically.
- Uninstalling Mirasim, clearing `%LOCALAPPDATA%`, or a disk failure can still remove backups. Keep a separate backup for important environments.

## SSH private keys and privacy

The patcher **does not read, copy, or upload the contents of SSH private keys**, and no private key should ever be added to this repository. When Mirasim connects, Windows OpenSSH reads the local key referenced by your SSH settings. That is normal SSH client behavior and is separate from the patcher itself reading a file.

The Mirasim connection form does not import every value from `.ssh/config` into its fields. Enter the actual username, host address, port, and private-key path. When using a `Host` alias, also enter its non-default port because the form passes its port to OpenSSH as a command-line option.

- Never upload `id_rsa`, `id_ed25519`, `.pem`, `.ppk`, or any other private key in an issue, log, screenshot, test fixture, or commit.
- Sanitize hostnames, IP addresses, usernames, local user directories, key paths, and remote paths before publishing a bug report.
- `status --json` can contain local installation and backup paths. Sanitize it before sharing.
- Applying the patch does not connect to a remote host. Patched Mirasim connects only to SSH targets configured by the user.
- The native askpass launcher passes the OpenSSH prompt to Mirasim's local `askpass.cjs` and returns its standard output to `ssh.exe`. It does not record or upload the answer.

## Security boundaries and known limitations

- This is a compatibility patch for the internals of specific Mirasim versions, not a general-purpose SSH client.
- A Mirasim update or package-layout change may require a new adapter.
- The legacy Linux runtime targets Linux x86_64 and specific glibc environments. Other architectures and distributions are not guaranteed.
- The tool does not bypass SSH host-key verification, server authentication, network policy, or account permissions.
- This repository and its releases must not contain `Mirasim.exe`, `app.asar`, Mirasim server/web assets, or other proprietary Mirasim files.

See [SECURITY.md](SECURITY.md) for reporting security issues. Third-party components and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Code authored for this repository is licensed under the [MIT License](LICENSE). Mirasim and all third-party components remain subject to their respective licenses. This project's MIT License does not grant rights to Mirasim software.
