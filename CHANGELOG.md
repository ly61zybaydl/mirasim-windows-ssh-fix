# Changelog

## 0.2.0

- Support Mirasim Desktop 0.0.348 with remote payload 0.0.372: the launch hook now recognizes the standalone connect flow (`ctx.setStatus({step:'launching'})`) as well as the earlier class-based flow.
- Ship the glibc 2.17 build of Node.js v24.19.0, matching the Node.js major that Mirasim remote payloads have bundled since 0.0.211; the `node-pty` binary is an N-API build and loads unchanged in Node.js 22 and 24.
- Make old-glibc support self-healing on the remote: the compatibility runtime is stored in `~/.mirasim-remote/compat/` and a marked `~/.ssh/rc` hook swaps it into every newly delivered payload before Mirasim launches it, so a later Desktop update that wipes the local patch no longer breaks old remotes.
- Skip re-uploading the 35 MB runtime archive when the remote compat store already holds it.
- Migrate an installed 0.1.x helper to the new one during `repair` without touching the original backup.
- Derive the shipped Linux compatibility assets from `assets/linux-compat/manifest.json` in the installer, the release workflow and the tests.

## 0.1.4

- Verify Mirasim Desktop 0.0.214 together with downloaded UI runtime 0.0.216; capability detection applies without code changes, and 0.0.214 is now listed as tested.
- Confirm the desktop shell main process still hosts Remote SSH and its tunnel in the 0.0.214 + downloaded-runtime architecture, so the tunnel-policy fix keeps applying after official updates.

## 0.1.3

- Support Mirasim Desktop 0.0.208 and its native Windows Remote SSH transport.
- Detect Windows SSH capabilities instead of selecting a patch path from a fixed version list.
- Keep the native Windows plain tunnel alive when an unrelated SSH-config `RemoteForward` fails.
- Install the glibc 2.17 compatibility runtime after a newly delivered remote payload becomes active, including remote server 0.0.208.
- Ignore downloaded UI runtimes that are not newer than the bundled Desktop version.

## 0.1.2

- Patch the active downloaded Mirasim UI runtime selected from `.mirasim/app/state.json`, not only the bundled fallback renderer.
- Start the Electron Remote SSH IPC bridge on Windows so the unlocked frontend can load and save SSH hosts.
- Keep Mirasim's own local tunnel alive when an unrelated `RemoteForward` from the user's SSH config cannot be opened.
- Back up and restore the runtime renderer file together with `app.asar`.
- Report the shell version and active runtime frontend state separately.
- Add compatibility coverage for runtime UI 0.0.207.

## 0.1.1

- Enable the Remote SSH host manager and add-host entry in the Windows renderer.
- Make `status` report main-process and frontend patch state separately.
- Let `repair` upgrade an existing 0.1.0 main-only patch without replacing its original backup.

## 0.1.0

- Initial Windows Remote SSH main-process patch, native askpass helper, compatibility assets, backup, repair and restore commands.
