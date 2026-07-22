# pi-agent-qqbot 全面重构设计

## 1. 背景与目标

当前项目是一个连接 QQ 官方机器人 API 与本地 Pi coding agent 的 TypeScript 扩展。项目功能已经覆盖 QQ WebSocket 接入、访问控制、隔离 Agent 会话、远程命令、入站附件、出站文件、终端视图和热重载，但源码仍为根目录平铺结构，核心运行时集中在大型类中，测试、类型检查和跨平台约束不足。

本次重构的目标是：

- 将项目及 npm 包身份统一为 `pi-agent-qqbot`。
- 建立职责清晰、依赖方向明确、可独立测试的架构。
- 采用符合 Pi 官方规范的 npm 包结构。
- 仅支持原生 macOS、Linux 和 Windows，明确排除 WSL 与其他混合路径环境。
- 为关键运行时、配置、平台路径和安全边界建立自动化测试。
- 保持 QQ 机器人现有用户能力，但不保留旧项目内部结构或旧配置文件名兼容。
- 本轮只进行本地开发、打包和加载验证，不发布 npm 包，不修改远端仓库。

## 2. 范围

### 2.1 包含

- 生产源码、测试、配置示例和历史计划的目录重组。
- package metadata、README、日志标识、User-Agent、临时目录、host symbol、session namespace 等项目身份重命名。
- `router.ts`、`index.ts`、`types.ts` 等高耦合模块的重建与拆分。
- QQ transport、Pi SDK、文件系统和媒体能力的端口/适配器化。
- 原生 macOS、Linux、Windows 路径和文件系统行为。
- 严格 TypeScript 配置、统一测试入口、类型检查、打包内容检查和本地 Pi 加载验证。
- 将本机旧配置 `~/.pi/agent/pi-qqbot.json` 重命名为 `~/.pi/agent/pi-agent-qqbot.json`，用于本地烟雾测试。

### 2.2 不包含

- WSL 路径识别、`C:\...` 与 `/mnt/c/...` 之间的自动转换或兼容。
- 旧配置文件名的自动探测、读取或迁移逻辑。
- npm publish、npm deprecate、发布版本管理或远端仓库重命名。
- QQ 官方 API 能力之外的新产品功能。
- 对外提供通用 JavaScript library API、构建 `dist/` 或维护深导入兼容。

## 3. 关键决策

### 3.1 全面重建而非渐进 facade 兼容

重构采用重新定义边界并替换旧实现的方式。旧的 `PiQQBotRuntime` 大型编排类、根目录全域 `types.ts` 和入口内联命令闭包不作为长期兼容 facade 保留。行为通过新测试锁定，内部结构允许彻底调整。

### 3.2 Pi 原生 TypeScript 源码包

Pi 官方扩展加载器通过 jiti 直接加载 TypeScript。包入口设为 `./src/index.ts`，不生成 `dist/`，也不增加暗示公共 library API 的 `main` 或 `exports`。运行依赖放入 `dependencies`；Pi 核心包按官方要求使用 `peerDependencies` 的 `"*"` 范围。

### 3.3 原生平台契约

支持范围仅为：

- macOS 原生 Node.js 进程；
- Linux 原生 Node.js 进程；
- Windows 原生 Node.js 进程。

路径输入始终按当前宿主平台解释。Windows drive path、UNC path 和长路径只在 Windows 上按 Windows 语义处理；POSIX absolute path 只在 macOS/Linux 上按 POSIX 语义处理。跨平台路径字符串不在另一平台自动映射。

### 3.4 完全采用新配置身份

运行时只读取 `~/.pi/agent/pi-agent-qqbot.json`。旧 `pi-qqbot.json` 不被探测。配置示例命名为 `pi-agent-qqbot.json.example`。

本地烟雾测试前执行受保护的文件重命名：仅当旧文件存在且新文件不存在时移动；若新文件已存在则停止并报告，不覆盖；不读取、不打印配置内容或凭据。

### 3.5 保留用户命令语义

`/qqbot-start`、`/qqbot-stop`、`/qqbot-status` 等命令描述 QQ bot 功能，并非旧包身份，因此保留。QQ 侧 `/model`、`/thinking`、`/new`、`/sessions`、`/resume`、`/name`、`/compact`、`/stop` 等命令语义保持不变。

## 4. 目标目录结构

```text
pi-agent-qqbot/
├── src/
│   ├── index.ts
│   ├── extension/
│   │   ├── register-local-commands.ts
│   │   ├── access-approval-ui.ts
│   │   └── lifecycle.ts
│   ├── application/
│   │   ├── bot-runtime.ts
│   │   ├── process-inbound-message.ts
│   │   ├── execute-remote-command.ts
│   │   ├── run-agent-turn.ts
│   │   └── deliver-reply.ts
│   ├── domain/
│   │   ├── access.ts
│   │   ├── conversation.ts
│   │   ├── errors.ts
│   │   ├── message-dedupe.ts
│   │   ├── message-queue.ts
│   │   └── reply-budget.ts
│   ├── infrastructure/
│   │   ├── config/
│   │   │   ├── config-repository.ts
│   │   │   ├── normalize-config.ts
│   │   │   └── paths.ts
│   │   ├── pi/
│   │   │   ├── sdk-loader.ts
│   │   │   ├── agent-session.ts
│   │   │   └── conversation-registry.ts
│   │   ├── qq/
│   │   │   ├── auth.ts
│   │   │   ├── api.ts
│   │   │   ├── gateway.ts
│   │   │   └── payload-normalizer.ts
│   │   ├── media/
│   │   │   ├── attachment-downloader.ts
│   │   │   ├── attachment-pipeline.ts
│   │   │   ├── document-extractors.ts
│   │   │   ├── outbound-media.ts
│   │   │   └── stt.ts
│   │   └── platform/
│   │       ├── local-paths.ts
│   │       └── opened-file-identity.ts
│   └── presentation/
│       ├── qq/
│       │   ├── command-parser.ts
│       │   ├── keyboard.ts
│       │   ├── model-pages.ts
│       │   ├── reply-formatter.ts
│       │   └── user-facing-errors.ts
│       └── terminal/
│           ├── conversation-view.ts
│           ├── event-reducer.ts
│           └── widget.ts
├── test/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   └── run-all.ts
├── scripts/
│   └── check-package.mjs
├── docs/
│   ├── plans/
│   └── superpowers/
├── pi-agent-qqbot.json.example
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
└── LICENSE
```

文件可在实施中进一步合并，但必须遵守以下边界：每个文件有一个明确职责；application 不依赖具体 QQ、Pi 或文件系统实现；domain 不依赖 application、infrastructure 或 presentation。

## 5. 架构与依赖

### 5.1 Domain

Domain 包含不依赖外部服务的规则：访问权限、conversation key、消息去重、FIFO 队列状态、回复序号/配额和稳定错误码。所有对象应可通过同步单元测试验证。

`ReplyBudget` 是回复配额的唯一所有者，负责为进度回执、媒体、Markdown fallback 和最终文本分配序号。任何适配器不得直接修改共享 `nextMsgSeq`。

### 5.2 Application

Application 由显式用例组成：

1. 接收入站消息并执行授权、去重与命令/prompt 分流；
2. 将 prompt 入队并按 FIFO 执行；
3. 准备附件并调用隔离 Pi Agent session；
4. 收集工具事件和出站媒体记录；
5. 使用统一回复交付用例返回 QQ；
6. 在 abort、失败和正常结束时执行确定性清理。

Application 只依赖端口接口，例如 `QQGatewayPort`、`QQReplyPort`、`AgentSessionPort`、`AttachmentPort`、`ConfigRepository` 和 `RuntimeObserver`。

### 5.3 Infrastructure

Infrastructure 实现端口：QQ OAuth/API/WebSocket、Pi SDK 动态加载与 session、配置文件、附件下载、文档提取、STT 和本地文件发送。适配器将外部错误归一化为 domain/application 能理解的稳定错误。

SDK 定位不能只依赖 `process.argv[1]` 的包名子串。解析顺序应包括显式注入、Node module resolution 和经过验证的 launcher fallback，并验证目标文件存在。

### 5.4 Presentation

Presentation 负责 QQ 文本、Markdown、键盘、命令参数展示和终端 UI。终端事件 reducer 与 widget 渲染分离，使状态归约可以在无 TUI 环境中测试。

### 5.5 Extension composition root

`src/index.ts` 是唯一 composition root。它创建适配器、组装 application 服务、注册命令和生命周期事件。长生命周期资源只在 `session_start` 或显式启动命令中启动，并在 `session_shutdown` 幂等释放。

## 6. 数据流

```text
QQ WebSocket event
  -> payload normalizer
  -> process inbound message
  -> access + dedupe + command/prompt routing
  -> command use case OR FIFO queue
  -> attachment pipeline
  -> isolated Pi agent session
  -> outbound media tool + agent result
  -> reply budget
  -> QQ reply adapter
  -> runtime observer / terminal reducer
```

配置更新流：

```text
local approval command
  -> access application service
  -> serialized config repository mutation
  -> unique temporary file
  -> flush/close
  -> atomic replace
  -> in-memory config refresh
```

## 7. 平台与文件安全

### 7.1 路径

- 使用 `node:path` 当前平台实现，不对输入做跨平台翻译。
- 相对路径相对于明确传入的 cwd 解析。
- allow root 与 candidate 均经过 `realpath` 后使用 `relative` 做 containment 检查。
- Windows 额外测试 drive path、UNC path、不同 drive、大小写和 separator 行为。
- macOS/Linux 测试 POSIX absolute/relative path、symlink 和权限错误。

### 7.2 打开的文件身份

- Linux：可使用 `/proc/self/fd/<fd>` 验证已打开文件身份。
- macOS/Windows：使用打开句柄的 stat、打开前后路径 metadata 和内容读取后的 stat 检测替换；不宣称提供 Linux `/proc` 等价保证。
- 所有平台拒绝非普通文件、超限文件和不允许的 hard link；symlink/junction 行为通过平台测试明确。

### 7.3 配置写入

配置 repository 使用进程内单写队列，避免并发 approve/revoke 丢更新。临时文件名使用安全随机值，不使用仅由 PID 和毫秒时间组成的名称。只有 `ENOENT` 被视为配置不存在，权限、目录、锁和 I/O 错误必须报告。

## 8. 错误处理与可观察性

- 外部边界错误转换为稳定 code、用户安全消息和可记录 technical cause。
- 用户回复不得包含 client secret、access token、完整本地敏感路径或堆栈。
- 日志前缀统一为 `pi-agent-qqbot`，User-Agent 不再保留过期硬编码版本。
- observer 失败不得改变消息处理结果。
- cleanup 使用幂等 finally 流程；清理失败记录但不覆盖主要业务错误。
- gateway reconnect、API retry 与消息处理 retry 分开，避免隐式重复回复。

## 9. 测试策略

### 9.1 工具链

- 增加严格 `tsconfig.json` 和 `npm run typecheck`。
- 使用跨平台 Node/TypeScript 测试入口，自动发现测试，不在 package script 中逐文件手工串联。
- 本地安装开发依赖后，所有诊断必须区分真实类型错误与缺依赖问题。

### 9.2 单元测试

至少覆盖：

- config normalization、路径选择、ENOENT 与其他 I/O 错误；
- access policy、conversation key、message dedupe、queue 和 reply budget；
- command parser/authorization、model page、keyboard 和 reply formatter；
- QQ payload/attachment normalization；
- Windows 和 POSIX 路径表格；
- 用户错误脱敏与稳定错误码。

### 9.3 集成测试

至少覆盖：

- runtime 的 allow/deny、去重、queue full、成功回复和失败回复；
- Agent abort、attachment cleanup、outbound context close；
- progress ack、媒体、Markdown fallback 和最终文本共享配额；
- host start/replace/drain/stop 生命周期；
- gateway heartbeat/reconnect 与重复事件；
- 并发配置 approve/revoke 不丢更新；
- 本地文件 allow-root、symlink/junction、rename race 和 hard-link 行为。

### 9.4 平台验证

本轮本机 Windows 必须实际运行：

```text
npm install
npm run typecheck
npm test
npm run pack:check
npm run test:package
```

`test:package` 检查 tarball 包含 `src/index.ts`、完整运行依赖图、README、LICENSE 和新配置示例，并排除测试、真实配置、环境文件、计划、git 数据和本地代理产物。

随后使用本地路径或 tarball 启动 Pi，验证扩展可发现、配置可加载、命令可注册、runtime 可启动/停止。真实 QQ 网络验证只有在现有凭据和网络条件允许时进行，测试输出不得显示凭据。

macOS/Linux 通过仓库中的 CI matrix 定义相同 typecheck/test/package gates。由于当前执行环境为 Windows，除非实际 CI 结果可用，否则最终报告必须明确 macOS/Linux 未在本机执行。

## 10. npm 与依赖规范

- `name`: `pi-agent-qqbot`。
- `pi.extensions`: `["./src/index.ts"]`。
- `files`: `src`、`pi-agent-qqbot.json.example`、`README.md`、`LICENSE`。
- `dependencies`: 非 Pi runtime dependencies，例如 `unpdf`、`ws`。
- `peerDependencies`: 实际导入的 Pi 核心包和 `typebox`，按 Pi 官方规范使用 `"*"`。
- `devDependencies`: TypeScript、Node/ws 类型和本地验证所需工具。
- Node engine 与实际 Pi host/test toolchain 的最低版本保持一致，并在该最低版本与当前支持版本上验证。
- `.npmignore` 只作为 defense in depth；发布边界以 `files` allowlist 和 package test 为准。

本轮不运行 `npm publish`，不修改 npm registry 中的 `@xsqm/pi-qqbot`。

## 11. README 与文档

README 中英文部分都必须：

- 使用 `pi-agent-qqbot` 新身份和新配置文件名；
- 分开给出 npm/git 安装与本地开发说明；
- 提供 bash/zsh 和 PowerShell 示例；
- 明确只支持原生 macOS/Linux/Windows，不支持 WSL 路径互操作；
- 不假设 scoped npm 包位于固定扩展目录；
- 说明安全边界、配置权限和本地文件出站风险；
- 不包含旧包名、旧仓库名或旧配置命令示例。

现有根目录计划文档移动到 `docs/plans/legacy/` 并保留历史内容；历史文档中的旧名称属于历史语境，不要求改写，但 README 与当前规格不得把旧名称作为现行身份。

## 12. 实施顺序

1. 建立测试工具链和当前行为 characterization tests。
2. 修复原生 Windows 基线并删除 WSL 路径契约。
3. 建立 domain 类型与端口接口。
4. 实现 infrastructure adapters 和 application use cases。
5. 重建 extension composition root 与 presentation。
6. 删除旧模块并完成目录、包身份和配置示例重命名。
7. 更新 README、package metadata 和打包检查。
8. 运行完整本地验证。
9. 受保护地重命名真实本机配置并执行 Pi 本地烟雾测试。
10. 审查最终 diff、残余风险和未在本机运行的平台验证。

## 13. 完成标准

只有同时满足以下条件才算完成：

- 生产代码不存在旧项目身份的现行引用，历史归档除外。
- 运行时只读取新配置路径，真实本机配置已按约束重命名。
- WSL 自动映射代码、测试和现行文档全部删除。
- 新架构遵守依赖方向，核心编排不再集中于单个超大类。
- typecheck、全部自动化测试、package check 和本地 Pi 加载 smoke test 通过。
- tarball 不包含真实配置、凭据、测试、计划或本地产物。
- macOS/Linux/Windows 的平台行为均有自动化测试定义。
- 最终报告明确实际执行过的平台和未执行的验证，不把 CI 定义误报为已验证结果。
- 未执行 npm 发布或远端仓库变更。
