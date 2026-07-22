# pi-agent-qqbot

`pi-agent-qqbot` connects the official QQ Bot API to a local Pi coding agent. It supports native macOS, Linux, and Windows. WSL and mixed Windows/WSL path translation are not supported.

The npm package has not been published. Install from a local checkout.

## 中文

### 安装

bash/zsh:

```bash
npm install
pi install /absolute/path/to/pi-agent-qqbot
```

PowerShell:

```powershell
npm install
pi install C:\absolute\path\to\pi-agent-qqbot
```

也可以在 Pi 中使用本地 package path。安装或升级后完整重启 Pi，避免旧 host/session 状态被新身份接管。

### 配置

扩展只读取：

- macOS/Linux: `~/.pi/agent/pi-agent-qqbot.json`
- Windows: `%USERPROFILE%\.pi\agent\pi-agent-qqbot.json`

bash/zsh:

```bash
cp pi-agent-qqbot.json.example ~/.pi/agent/pi-agent-qqbot.json
chmod 600 ~/.pi/agent/pi-agent-qqbot.json
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.pi\agent"
Copy-Item .\pi-agent-qqbot.json.example "$HOME\.pi\agent\pi-agent-qqbot.json"
```

填写 QQ Bot `appId` 和 `clientSecret`，将 `enabled` 改为 `true`，并配置 `allowUsers` / `allowGroups`。真实配置和密钥不能提交到 Git。

### 命令

本地 Pi 命令保持不变：`/qqbot-start`、`/qqbot-stop`、`/qqbot-status`、`/qqbot-runtime`、`/qqbot-reconnect`、`/qqbot-last`、`/qqbot-requests`、`/qqbot-approve`、`/qqbot-deny`、`/qqbot-revoke`。

QQ 远程命令保持不变：`/help`、`/status`、`/last`、`/model`、`/thinking`、`/new`、`/sessions`、`/resume`、`/name`、`/compact`、`/stop`，以及兼容别名 `/qqbot-help`、`/qqbot-status`、`/qqbot-last`。

### 安全边界

- 未授权消息先拒绝，不下载附件，也不保存正文。
- 每个 QQ 对话使用隔离 session namespace。
- 入站媒体受 HTTPS、SSRF、重定向、大小和超时限制。
- 本地文件出站默认关闭，仅允许显式 root 内的普通文件；realpath、symlink/junction、hard link、rename race 和大小都会校验。
- Windows drive/UNC、POSIX 路径均按当前宿主原生语义处理，不做跨平台路径转换。
- 模型不能指定 QQ target、`msg_id` 或回复序号。

## English

### Install

This package is not published to npm yet. Run `npm install`, then install the checkout by absolute local path with `pi install <path>`. Fully restart Pi after installation or upgrade.

### Configure

Copy `pi-agent-qqbot.json.example` to `~/.pi/agent/pi-agent-qqbot.json` on macOS/Linux, or `%USERPROFILE%\.pi\agent\pi-agent-qqbot.json` on Windows. Set QQ credentials, enable the extension, and configure allowlists. Never commit the real config or secrets.

### Platform And Security

Native macOS, Linux, and Windows are supported. WSL and hybrid path conversion are explicitly unsupported. The extension applies authorization before attachment work, isolates sessions by QQ conversation, bounds media processing, and keeps outbound local-file delivery disabled unless explicit roots and permissions are configured.

## Development

```bash
npm run typecheck
npm test
npm run identity:check
npm run test:package
npm run smoke:pi -- .
```

No publish job is configured. `npm publish`, remote pushes, and remote repository changes are outside the local verification workflow.
