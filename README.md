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
- 唯一的 QQ user `ownerOpenId`
- `sandbox` 是否使用 QQ 沙箱环境

真实配置和密钥不能提交到 Git。扩展只支持该用户的 C2C 私聊，群消息在附件下载和 Agent 工作前直接忽略。

`0.8.0` 只接受显式的 `schemaVersion: 5`。旧版本和缺少版本号的配置会以 `unsupported_schema` 拒绝加载，不做兼容读取或字段迁移。升级时必须按示例一次性替换旧结构。`deniedKinds`、`deniedExtensions` 和 `deniedRoots` 都是黑名单；空数组或省略字段表示不增加对应限制。

`outboundMedia.enabled` 仍是本地文件出站总开关。启用后，空的 `deniedRoots` 允许发送 Pi 进程当前账户可读取的所有普通文件。可选外部语音转写配置放在 `inboundMedia.stt`，包含 `baseUrl`、`apiKeyEnv` 和 `model`；QQ 已提供 ASR 文本时总是优先使用 QQ 文本。

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

QQ 可用命令采用显式白名单：`/help`、`/status`、`/model`、`/thinking`、`/new`、`/sessions`、`/resume`、`/name`、`/compact`、`/stop`。`/help`、`/model`、`/thinking` 和会话选择会发送 QQ Keyboard；不支持按钮时仍可手动发送对应命令。

QQ 不能执行任何 `/qqbot-*` 本地控制命令。Pi 原生 `/new`、`/resume`、`/fork` 和 session switching 会保留 link 并更新到新 session。Terminal 发起的 Agent 回复不会镜像到 QQ。

当 QQ 发起的 Pi 回合调用标准 `ctx.ui.confirm`、`ctx.ui.select` 或 `ctx.ui.input` 时，扩展会同时保留终端弹窗并发送 QQ 交互卡片；任意一端最先完成的响应生效，另一端的响应会失效。选择项会分页显示；文本输入直接回复下一条 QQ 文本消息。自定义终端组件和没有 QQ 来源消息的本地回合仍只在终端处理。

### 所有权与安全

- 仅接受配置中的唯一 C2C 用户；其他用户和群消息在附件处理或 Agent 工作前被忽略。
- `link.conflictPolicy: "ask"` 会在新 Pi 本地确认；`"takeover"` 会直接请求旧 owner 交接。
- 接管使用 appId 范围的 owner record、PID、随机 nonce 和 loopback endpoint；不会终止旧 Pi 进程。
- 入站媒体不设置扩展层数量、格式、单文件或总量上限；未知格式作为临时文件交给 Pi 工具按需读取。
- 入站下载仍强制 HTTPS、SSRF 防护、有限重定向、取消处理和网络停滞检测；这些是安全不变量，不是产品配额。
- 本地文件出站总开关默认关闭；启用后路径采用黑名单策略，默认允许当前 Pi 账户可读取的目录，`outboundMedia.deniedRoots` 中的 root 及其子目录禁止发送。
- 所有候选文件仍经过 realpath、symlink/junction、hard-link、rename-race 和普通文件校验，禁用目录按规范化后的真实路径判定。
- 出站使用 QQ 官方分片上传协议。图片、视频和语音超过软限制时自动降级为普通文件；200 MB 硬限制和每条消息 4 次被动回复来自 QQ 平台，不是用户配置。
- 模型不能指定 QQ target、`msg_id` 或回复序号。

## English

Copy `pi-agent-qqbot.json.example` to `~/.pi/agent/pi-agent-qqbot.json` (or `%USERPROFILE%\.pi\agent\pi-agent-qqbot.json` on Windows). Configure one `ownerOpenId`, then run `/qqbot-start` and `/qqbot-link` locally.

Loading Pi never starts the QQ Gateway. `/qqbot-stop` pauses transport without dropping the in-process link; `/qqbot-start` resumes it. Native Pi session changes retain the link. Only QQ-originated runs reply to QQ, while terminal-originated output remains local.

## Development

```bash
npm run verify
npm run test:package
npm run smoke:pi -- .
```

No publish job is configured. Publishing, remote pushes, and remote repository changes are outside this local verification workflow.
