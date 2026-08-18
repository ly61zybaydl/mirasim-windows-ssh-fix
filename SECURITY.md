# Security Policy

## Supported versions

Security fixes are provided only for the current tool release line. Versions listed in [README.md](README.md) are the ones tested by this project; other versions are attempted when their internal structure is compatible.

This project is an unofficial compatibility tool. It does not replace Mirasim's own security process, and it cannot provide support for vulnerabilities in Mirasim, OpenSSH, Node.js, Electron, or a remote Linux system.

## Reporting a vulnerability

Do not open a public Issue containing an exploit, private key, credential, private hostname, IP address, username, user-directory path or unsanitized log.

When the repository's GitHub **Private vulnerability reporting** feature is available, use **Security → Report a vulnerability**. If it is not available, contact a maintainer through a trusted private channel and disclose only enough information to arrange a secure handoff. Public Issues are appropriate only for already-sanitized, non-sensitive compatibility bugs.

Include, after redaction:

- patcher version and Mirasim version;
- Windows version and CPU architecture;
- the command that failed and the smallest reproducible steps;
- expected and actual behavior;
- relevant error messages, with local paths and server details replaced by placeholders.

`status --json` can contain installation and backup paths. Review it manually before sharing. Never attach SSH private keys, SSH agent exports, credential files, full SSH configuration, Mirasim proprietary binaries, `app.asar`, or memory dumps that may contain secrets.

## Safe recovery

Stop Mirasim before applying, repairing, or restoring. The tool keeps a normal external backup of `app.asar`; preserve that backup and report a sanitized issue if an operation fails.
