# pi-agent-qqbot

`pi-agent-qqbot` connects one QQ C2C conversation to the currently active native Pi session. A QQ message behaves like another user typing into the same Pi runtime: it uses the same working directory, model, tools, context, and session history.

The extension supports native macOS, Linux, and Windows. WSL and mixed Windows/WSL path translation are not supported.

## 中文

### 安装

本包尚未发布到 npm。安装依赖后，用绝对路径安装本地 checkout：

```bash
npm install
pi install /absolute/path/to/pi-agent-qqbot
```

PowerShell:

```powershell
npm install
pi install C:\absolute\path\to\pi-agent-qqbot
```

安装或升级后完整退出并重启 Pi。

### 配置

扩展只读取 `~/.pi/agent/pi-agent-qqbot.json`；Windows 对应 `%USERPROFILE%\.pi\agent\pi-agent-qqbot.json`。复制 `pi-agent-qqbot.json.example` 后填写：

- 一个 QQ Bot `appId` 和 `clientSecret`
- `enabled: true`
- `allowUsers` 中恰好一个非空 QQ user OpenID
- 空的 `allowGroups`
- `commands.allowInGroups: false`

真实配置和密钥不能提交到 Git。旧 `startup`、`sessions`、访问审批和管理员字段会被忽略，不能触发自动启动或创建独立 QQ session。

### 使用

扩展加载时不会连接 QQ。每次新 Pi 进程都需要在本机终端执行：

```text
/qqbot-start
/qqbot-link
```

本地控制命令：

- `/qqbot-start` 启动 Gateway；同进程重启会复用已有 link
- `/qqbot-stop` 只停止 Gateway，保留 link 和当前 Pi session
- `/qqbot-link` 将唯一配置的 C2C 用户绑定到当前 Pi runtime
- `/qqbot-unlink` 解除 link，并使尚未完成的旧 QQ 回复失效
- `/qqbot-status` 查看 Gateway、link 和 native Pi session 状态
- `/qqbot-takeover` 从本机另一个 Pi 进程接管 Gateway

QQ 可用命令：`/help`、`/status`、`/model`、`/thinking`、`/new`、`/sessions`、`/resume`、`/name`、`/compact`、`/stop`。

QQ 不能执行任何 `/qqbot-*` 本地控制命令。Pi 原生 `/new`、`/resume`、`/fork` 和 session switching 会保留 link 并更新到新 session。Terminal 发起的 Agent 回复不会镜像到 QQ。

### 所有权与安全

- 仅接受配置中的唯一 C2C 用户；其他用户和群消息在附件处理或 Agent 工作前被忽略。
- `link.conflictPolicy: "ask"` 会在新 Pi 本地确认；`"takeover"` 会直接请求旧 owner 交接。
- 接管使用 appId 范围的 owner record、PID、随机 nonce 和 loopback endpoint；不会终止旧 Pi 进程。
- 入站媒体受 HTTPS、SSRF、重定向、大小和超时限制。
- 本地文件出站默认关闭，只允许显式 root 内经过 realpath、symlink/junction、hard-link、rename-race 和大小校验的普通文件。
- 模型不能指定 QQ target、`msg_id` 或回复序号。

## English

Copy `pi-agent-qqbot.json.example` to `~/.pi/agent/pi-agent-qqbot.json` (or `%USERPROFILE%\.pi\agent\pi-agent-qqbot.json` on Windows). Configure exactly one `allowUsers` OpenID, no groups, enable the extension, then run `/qqbot-start` and `/qqbot-link` locally.

Loading Pi never starts the QQ Gateway. `/qqbot-stop` pauses transport without dropping the in-process link; `/qqbot-start` resumes it. Native Pi session changes retain the link. Only QQ-originated runs reply to QQ, while terminal-originated output remains local.

## Development

```bash
npm run verify
npm run test:package
npm run smoke:pi -- .
```

No publish job is configured. Publishing, remote pushes, and remote repository changes are outside this local verification workflow.
