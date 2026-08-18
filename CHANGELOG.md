# Changelog

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
