# Mirasim Windows Remote SSH Fix

**简体中文** | [English](README.en.md)

一个面向 Windows 的 Mirasim Remote SSH 兼容补丁工具，支持应用、修复和恢复。

> [!IMPORTANT]
> 这是社区维护的**非官方工具**，与 Mirasim 官方无隶属或背书关系。它会备份并修改本机 Mirasim 安装目录中的 `resources/app.asar`，以及当前使用的 `%USERPROFILE%\.mirasim\app\<版本>\renderer` 前端，但不会修改 `Mirasim.exe`。使用前请关闭 Mirasim，并自行评估风险。

## 当前测试范围

| 项目 | 支持情况 |
| --- | --- |
| 本机系统 | Windows 10/11 x64 |
| Mirasim Desktop | `0.0.170`、`0.0.203`、`0.0.205`、`0.0.208`、`0.0.214` |
| Mirasim 下载式 UI runtime | `0.0.207`、`0.0.216` |
| 远端系统 | Linux x86_64；旧版兼容运行时已在 Ubuntu 18.04 x64 / glibc 2.27 验证 |
| SSH 客户端 | Windows OpenSSH (`ssh.exe` / `scp.exe`) |

表中版本已经实际测试。工具不按固定版本号选择补丁路径，而是检测 Windows SSH 能力和远端启动流程；后续版本只要保留兼容的语义结构，也会自动尝试应用。若内部流程、Node API 或 `node-pty` 布局发生不兼容变化，工具会报告具体错误，无法保证永久兼容所有未知版本。

## 它解决什么

较旧 Mirasim Desktop 的 Windows 构建会通过前端入口、Electron IPC bridge 和若干只适用于 Unix 的主进程实现阻止 Remote SSH；工具会补齐这些能力。`0.0.208`–`0.0.214` 及类似的新架构已原生支持 Windows SSH，工具只修复其隧道策略并为旧 glibc 的 Linux x86_64 主机安装兼容运行时。旧版使用的 Windows askpass 是仓库内源码编译的小型原生启动器，不经过 `cmd.exe`，因此提示文本中的引号、百分号、感叹号等字符不会被 shell 二次解释。

补丁过程会先备份原始 `app.asar` 和当前下载式 UI runtime 中需要修改的前端文件，然后应用修改并安装辅助资源。`restore` 可用来恢复工具创建的备份。

## 获取与使用

### 普通用户：使用完整 Release ZIP

完整 Release ZIP 包含独立的 Windows Node.js、旧版 Linux 兼容运行时和 `windows-askpass.exe`。GitHub 自动生成的 **Source code (zip/tar.gz)** 不包含这些大体积运行时文件，普通用户应下载 Release 页面中的 Windows ZIP。

1. 从 [Releases](https://github.com/ly61zybaydl/mirasim-windows-ssh-fix/releases) 下载适合 Windows x64 的完整 Release ZIP，并解压到普通目录。
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

如果已经使用过 `v0.1.0` 或 `v0.1.1`，请下载 `v0.1.2` 或更高版本，完整退出 Mirasim 后运行一次 `Mirasim-SSH-Fix.cmd repair`，再重新启动 Mirasim。`v0.1.2` 会同时修改 Mirasim 实际加载的下载式 UI runtime、启动 Windows IPC bridge，并避免 `.ssh/config` 中无关的 `RemoteForward` 失败导致连接反复重试。无需清理缓存；单独点击“重启 Server”不会重载 Electron bridge。

无关的 `RemoteForward` 仍可能在 OpenSSH 日志中产生警告；补丁会让 Mirasim 所需的本地隧道继续工作，但不会让那个远程转发本身成功。

如果 Mirasim 已更新到 `0.0.208`，或已经使用过 `v0.1.2`，请使用 `v0.1.3` 或更高版本运行 `repair`。官方更新会覆盖 `app.asar` 和辅助资源；`v0.1.3` 会识别新版原生 Windows SSH 架构，修复其隧道参数，并在 Ubuntu 18.04 / glibc 2.27 等旧系统上为新交付的远端版本重新安装兼容 Node 与 `node-pty`。

官方自动更新（例如更新到 `0.0.214`）会再次覆盖补丁：完整退出 Mirasim 后运行一次 `repair` 即可重新应用。`v0.1.4` 已实测 `0.0.214` 桌面版与下载式 UI runtime `0.0.216` 的组合。

如果 Mirasim 安装在非默认位置：

```bat
Mirasim-SSH-Fix.cmd status --app "D:\Apps\Mirasim"
Mirasim-SSH-Fix.cmd apply --app "D:\Apps\Mirasim"
```

通常不需要管理员权限；是否需要取决于所选安装目录的 Windows 权限。完整 Release ZIP 使用随包附带的独立 Node.js；源码运行可使用系统 Node.js 20 或更高版本。

### 开发者：从源码运行

需要 Node.js 20 或更高版本：

```powershell
npm ci
npm test
npm run build:askpass
node src/cli.cjs status
```

`npm run build:askpass` 使用 Windows 自带的 .NET Framework C# 编译器，从 [`native/windows-askpass/Program.cs`](native/windows-askpass/Program.cs) 重建启动器。源码检出不含清单中标为 `releaseAsset` 的大文件，因此默认用于开发；完整可分发包由发布工作流生成。请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/RELEASE.md](docs/RELEASE.md)，不要把 Mirasim 自身文件提交进 Git。

## 命令说明

- `status` / `detect`：检测安装位置、版本、补丁和兼容资源状态；加 `--json` 可输出 JSON。
- `apply`：创建外部备份并应用补丁。
- `repair`：官方更新覆盖补丁后重新应用；如果代码补丁仍在但兼容资源缺失，则只恢复资源。
- `restore`：从工具创建的备份恢复原始文件。

## 软件更新会覆盖补丁吗？

**会。** Mirasim 的 Windows 安装器更新通常会重装应用目录；Mirasim 还会单独下载新的 UI runtime。因此 `resources/app.asar`、当前 runtime 前端和本工具安装的兼容资源都可能被替换。补丁工具及其外部备份通常仍保留。

更新后按以下顺序处理：

1. 关闭 Mirasim。
2. 使用最新版工具运行 `status`。
3. 运行 `repair`；工具会为未测试的新版本尝试相同的语义补丁。
4. 如果内部代码结构已经变化，`repair` 会报告无法匹配的位置，此时请提交脱敏后的错误信息以便适配。

## 备份与恢复语义

默认备份位置：

```text
%LOCALAPPDATA%\MirasimRemoteSshPatcher\backups\<Mirasim版本>\app.asar
%LOCALAPPDATA%\MirasimRemoteSshPatcher\backups\runtime\<runtime版本>\renderer\...
```

状态文件保存在 `%LOCALAPPDATA%\MirasimRemoteSshPatcher\state.json`。

- 成功恢复不会自动删除外部备份。
- 卸载 Mirasim、清理 `%LOCALAPPDATA%` 或磁盘故障仍可能移除备份；重要环境请另行备份。

## SSH 私钥与隐私

本补丁工具**不会读取、复制或上传 SSH 私钥内容**，也不需要你把私钥加入本仓库。连接时，Mirasim 启动的 Windows OpenSSH 会按你的 SSH 配置读取本机私钥，这是正常的 SSH 行为，与补丁器自身读取文件不同。

Mirasim 的连接表单不会自动导入整份 `.ssh/config`。请在表单中填写实际用户名、主机地址、端口和私钥路径；使用 `Host` 别名时也要填写该主机的非默认端口，因为表单端口会作为命令行参数传给 OpenSSH。

- 永远不要在 Issue、日志、截图、测试夹具或提交中上传 `id_rsa`、`id_ed25519`、`.pem`、`.ppk` 或其他私钥。
- 发布问题报告前，请脱敏主机名、IP、用户名、本机用户目录、密钥路径和远端路径。
- `status --json` 可能包含本机安装路径与备份路径；分享前同样需要脱敏。
- 工具应用补丁时不连接远端主机；补丁后的 Mirasim 只会连接你配置的 SSH 目标。
- 原生 askpass 启动器只把 OpenSSH 的提示传给 Mirasim 自带的本地 `askpass.cjs`，并把其标准输出原样交还 `ssh.exe`；它不记录或上传回答。

## 安全边界与已知限制

- 这是针对特定 Mirasim 版本内部结构的兼容补丁，不是通用 SSH 客户端。
- Mirasim 更新或包结构变化可能要求新的适配。
- 旧版 Linux 运行时仅面向 Linux x86_64 和特定 glibc 场景；其他架构或发行版不作保证。
- 工具不会绕过 SSH 主机密钥校验、服务器认证、网络策略或账号权限。
- 本仓库及 Release 不应包含 `Mirasim.exe`、`app.asar`、Mirasim server/web 资源或其他 Mirasim 专有文件。

发现安全问题请参阅 [SECURITY.md](SECURITY.md)。第三方组件与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## License

本仓库自有代码采用 [MIT License](LICENSE)。Mirasim 及所有第三方组件仍分别受其各自许可约束；本项目的 MIT License 不授予任何 Mirasim 软件权利。
