# Mirasim Windows Remote SSH Fix

一个面向 Windows 的、可验证且可恢复的 Mirasim Remote SSH 兼容补丁工具。

> [!IMPORTANT]
> 这是社区维护的**非官方工具**，与 Mirasim 官方无隶属或背书关系。它会修改本机 Mirasim 安装目录中的 `resources/app.asar`，并在需要时同步更新 `Mirasim.exe` 内的 ASAR 完整性元数据。使用前请关闭 Mirasim，并自行评估风险。

## 当前支持范围

| 项目 | 支持情况 |
| --- | --- |
| 本机系统 | Windows 10/11 x64 |
| Mirasim Desktop | `0.0.170`、`0.0.203`、`0.0.205` |
| 远端系统 | Linux x86_64；旧版兼容运行时已在 Ubuntu 18.04 x64 / glibc 2.27 验证 |
| SSH 客户端 | Windows OpenSSH (`ssh.exe` / `scp.exe`) |

工具使用明确的版本允许列表，并进一步检查 Mirasim 包身份和待修改代码结构。未列出的版本、结构不匹配的构建、带有 `app.asar.unpacked` 的构建都会被拒绝；请勿强行绕过检查。

## 它解决什么

Mirasim Desktop 的 Windows 构建中，Remote SSH 入口和若干只适用于 Unix 的实现会阻止连接。此工具针对受支持版本修复 Windows 平台限制、SSH askpass、端口转发、`scp` 和进程停止逻辑，并为旧 glibc 的 Linux x86_64 主机附带经过哈希校验的兼容运行时。Windows askpass 使用仓库内可审查源码编译的小型原生启动器，不经过 `cmd.exe`，因此提示文本中的引号、百分号、感叹号等字符不会被 shell 二次解释。

补丁过程会先备份原始 `app.asar` 和 `Mirasim.exe`，在临时文件中完成修改和校验，再进行替换。如果替换过程失败，工具会尝试自动回滚。

## 获取与使用

### 普通用户：使用完整 Release ZIP

完整 Release ZIP 才会包含独立的 Windows Node.js 运行时和旧版 Linux 兼容运行时等大体积二进制资源，并包含经过 SHA-256 校验的 `windows-askpass.exe`。GitHub 自动生成的 **Source code (zip/tar.gz)** 以及源码仓库本身故意不包含大体积运行时文件，不能直接用于普通用户的一键 `apply` 或完整 `repair`。

1. 下载适合 Windows x64 的完整 Release ZIP，并解压到普通目录。
2. 完全退出 Mirasim，包括可能仍在后台运行的进程。
3. 双击 `Mirasim-SSH-Fix.cmd`。无参数时默认执行 `apply`。
4. 再运行一次 `status`，确认补丁和兼容资源均处于健康状态。

常用命令：

```bat
Mirasim-SSH-Fix.cmd status
Mirasim-SSH-Fix.cmd apply
Mirasim-SSH-Fix.cmd repair
Mirasim-SSH-Fix.cmd restore
```

如果 Mirasim 安装在非默认位置：

```bat
Mirasim-SSH-Fix.cmd status --app "D:\Apps\Mirasim"
Mirasim-SSH-Fix.cmd apply --app "D:\Apps\Mirasim"
```

通常不需要管理员权限；是否需要取决于所选安装目录的 Windows 权限。完整 Release ZIP 优先使用随包附带且经过 SHA-256 校验的独立 Node.js；源码运行可使用系统 Node.js 20 或更高版本。工具绝不会借目标 `Mirasim.exe` 运行并修改它自身。

### 开发者：从源码运行

需要 Node.js 20 或更高版本：

```powershell
npm ci
npm test
npm run build:askpass
node src/cli.cjs status
```

`npm run build:askpass` 使用 Windows 自带的 .NET Framework C# 编译器，从 [`native/windows-askpass/Program.cs`](native/windows-askpass/Program.cs) 重建启动器，并同时核对源码和产物哈希。源码检出不含清单中标为 `releaseAsset` 的大文件，因此默认只能用于开发、审查和不依赖这些资源的检查。请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/RELEASE.md](docs/RELEASE.md)，不要把 Mirasim 自身文件或第三方大二进制提交进 Git。

## 命令说明

- `status` / `detect`：只读检测安装位置、版本、补丁状态、Electron fuse、ASAR 哈希和兼容资源状态；加 `--json` 可输出 JSON。
- `apply`：创建哈希校验的外部备份，生成并验证补丁，然后以事务方式替换文件。
- `repair`：官方更新覆盖补丁后重新应用；如果代码补丁仍在但兼容资源缺失，则只恢复资源。
- `restore`：仅在当前版本和当前文件哈希与已记录的补丁状态完全匹配时恢复原始文件。

`--allow-unsigned-output` 只用于明确接受 Authenticode 签名失效风险的特殊情况。未来的 Mirasim 若带有效签名，修改 EXE 会使签名失效；工具默认拒绝这种操作。不要把该参数当作通用的“强制”开关。

## 软件更新会覆盖补丁吗？

**会。** Mirasim 的 Windows 安装器更新通常会重装应用目录，因此 `Mirasim.exe`、`resources/app.asar` 和本工具安装的兼容资源都可能被替换。外部备份通常仍保留，但不能依赖它替代你自己的备份策略。

更新后按以下顺序处理：

1. 关闭 Mirasim。
2. 使用与新 Mirasim 版本兼容的最新版工具运行 `status`。
3. 只有当该版本出现在上方支持列表中时，运行 `repair`。
4. 如果显示不支持，请等待工具增加该精确版本；不要恢复旧版本的 `app.asar`，也不要强制套用旧补丁。

## 备份与恢复语义

默认备份位置：

```text
%LOCALAPPDATA%\MirasimRemoteSshPatcher\backups\<安装位置ID>\<Mirasim版本>\<原始ASAR哈希>-<原始EXE哈希>\
```

状态文件保存在同一数据根目录的 `state` 子目录。备份同时绑定安装位置、Mirasim 版本以及补丁前后的文件哈希。

- `restore` 不会把旧版备份写入已经更新的 Mirasim。
- 当前文件被官方更新、其他工具或人工修改后，哈希不匹配，恢复会被拒绝。
- 只有工具安装且内容未变化的兼容资源才会在恢复时删除；检测到修改会拒绝删除。
- 成功恢复不会自动删除外部备份。
- 卸载 Mirasim、清理 `%LOCALAPPDATA%` 或磁盘故障仍可能移除备份；重要环境请另行备份。

## SSH 私钥与隐私

本补丁工具**不会读取、复制或上传 SSH 私钥内容**，也不需要你把私钥加入本仓库。连接时，Mirasim 启动的 Windows OpenSSH 会按你的 SSH 配置读取本机私钥，这是正常的 SSH 行为，与补丁器自身读取文件不同。

- 永远不要在 Issue、日志、截图、测试夹具或提交中上传 `id_rsa`、`id_ed25519`、`.pem`、`.ppk` 或其他私钥。
- 发布问题报告前，请脱敏主机名、IP、用户名、本机用户目录、密钥路径和远端路径。
- `status --json` 可能包含本机安装路径与备份路径；分享前同样需要脱敏。
- 工具应用补丁时不连接远端主机；补丁后的 Mirasim 只会连接你配置的 SSH 目标。
- 原生 askpass 启动器只把 OpenSSH 的提示传给 Mirasim 自带的本地 `askpass.cjs`，并把其标准输出原样交还 `ssh.exe`；它不记录或上传回答。

## 安全边界与已知限制

- 这是针对特定 Mirasim 版本内部结构的兼容补丁，不是通用 SSH 客户端。
- Mirasim 更新、Electron fuse、代码签名或包结构变化都可能要求新的适配。
- 旧版 Linux 运行时仅面向 Linux x86_64 和特定 glibc 场景；其他架构或发行版不作保证。
- 工具不会绕过 SSH 主机密钥校验、服务器认证、网络策略或账号权限。
- 本仓库及 Release 不应包含 `Mirasim.exe`、`app.asar`、Mirasim server/web 资源或其他 Mirasim 专有文件。

发现安全问题请参阅 [SECURITY.md](SECURITY.md)。第三方组件与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## License

本仓库自有代码采用 [MIT License](LICENSE)。Mirasim 及所有第三方组件仍分别受其各自许可约束；本项目的 MIT License 不授予任何 Mirasim 软件权利。

---

**English summary:** This is an unofficial, version-gated, reversible Windows Remote SSH patcher for Mirasim Desktop. Use the complete release ZIP, not GitHub's generated source archive. Official Mirasim updates can overwrite the patch; run `status` and then `repair` only after the new version is explicitly supported. The patcher never reads, copies, or uploads private-key contents.
