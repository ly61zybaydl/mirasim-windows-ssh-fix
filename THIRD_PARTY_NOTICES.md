# Third-Party Notices

This file covers third-party material distributed with source installs or a complete release package. It complements the asset-local `assets/linux-compat/THIRD_PARTY_NOTICES.txt`; it does not replace license files included by individual packages.

Mirasim itself is **not** distributed by this project. The project's MIT License grants no rights to Mirasim software or trademarks.

## JavaScript dependencies

Versions are recorded in `package-lock.json`. A release package that bundles `node_modules` must retain each package's own license file, including transitive dependencies.

| Component | Version | License | Copyright / project |
| --- | --- | --- | --- |
| `@electron/asar` | 3.4.1 | MIT | Copyright (c) 2014 GitHub Inc. |
| `@electron/fuses` | 1.8.0 | MIT | Copyright (c) 2020 Electron Maintainers |
| `resedit` | 1.7.2 | MIT | Copyright (c) 2018 jet |

Their transitive dependencies are listed in `package-lock.json` and carry their own MIT or ISC license files in the installed packages.

## Independent Windows patcher runtime

The complete Windows Release ZIP includes the unmodified `node.exe` from Node.js v22.23.1 win-x64 so the target `Mirasim.exe` never has to modify itself.

- Distribution source: <https://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip>
- The upstream Node.js license is included as `runtime/NODE_LICENSE.txt`.

## First-party Windows askpass helper

`assets/windows-askpass/windows-askpass.exe` is compiled solely from this project's MIT-licensed `native/windows-askpass/Program.cs`; it does not embed a third-party library. It targets the Windows .NET Framework runtime supplied by the operating system.

## Legacy Linux compatibility assets

The following large files are intentionally excluded from Git history and are included only in a complete Release ZIP. Filenames and upstream sources are recorded in `assets/linux-compat/manifest.json`.

### Node.js v22.23.1 linux-x64-glibc-217

- Distribution source: <https://unofficial-builds.nodejs.org/download/release/v22.23.1/node-v22.23.1-linux-x64-glibc-217.tar.xz>
- Project: <https://github.com/nodejs/unofficial-builds>
- The unmodified archive contains the Node.js license and its own third-party notices. Those embedded files must remain in redistributed copies.

### node-pty 1.2.0-beta.14

- Source: <https://github.com/microsoft/node-pty>
- Binary in a complete release: `pty-node-v127-glibc217.node`
- License: MIT
- Copyright (c) 2012-2015, Christopher Jeffrey
- Copyright (c) 2016, Daniel Imms
- Copyright (c) 2018-present Microsoft Corporation

### node-addon-api 7.1.0

The `node-pty` native module is built using `node-addon-api`, a header-only dependency whose notices therefore accompany the binary distribution.

- Source: <https://github.com/nodejs/node-addon-api>
- License: MIT
- Copyright (c) 2017 Node.js API collaborators

### MIT license text for the components above

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Release obligations

Any change to a bundled dependency or runtime requires a license review. A complete Release ZIP must include this file, the asset-local notice and the independent runtime license; GitHub's automatically generated source archives omit the large binaries and are not end-user distributions.
