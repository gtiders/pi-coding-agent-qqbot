# Pi Coding Agent QQBot 远程命令与常驻运行优化规划书

> 文档类型：架构与交互规范 / 实施规划
> 文档状态：待评审，尚未实现
> 项目基线：`pi-coding-agent-qqbot` `main`，commit `1c711a5`
> Pi SDK 基线：本机 `@earendil-works/pi-coding-agent` v0.80.2
> 编写日期：2026-07-14
> 目标版本建议：v0.4.0

---

## 1. 文档目的

本文解决两个直接影响插件价值的问题：

1. 用户无法在 QQ 聊天框中可靠地执行 Pi 的会话级命令，例如切换模型、调整思考等级、新建会话、恢复会话、压缩上下文、终止当前任务。
2. QQ 网关生命周期绑定在当前交互式 Pi 会话上；用户在主机终端执行 `/new`、`/resume`、`/fork`、`/reload` 后，旧扩展实例执行 `session_shutdown` 并关闭网关，新实例又因 `autoStart: false` 不会重启，导致必须重新输入 `/qqbot-start`。

本规划的目标不是把 QQ 命令伪装成普通 prompt，也不是把远程输入注入本地 TUI 会话，而是把 QQBot 改造成一个**常驻、隔离、可管理的 Pi Agent 控制面**：

- QQ 网关在宿主 Pi 进程内常驻，不随本地会话切换而断开；
- QQ 使用自己的持久化 AgentSession，拥有独立模型、上下文和会话列表；
- QQ 命令通过明确的命令控制器调用 Pi SDK，而不是交给模型猜测；
- 普通问题仍然进入隔离 QQ 会话，不污染主机终端会话；
- 模型、会话和危险操作可通过适合手机聊天的命令、按钮、短列表和确认流程完成。

---

## 2. 需求重述与边界

### 2.1 用户真正需要的能力

用户需要在离开电脑终端时，仅通过 QQ 完成以下闭环：

- 查看当前 QQ Agent 的模型、思考等级、工作目录、会话、队列和连接状态；
- 列出可用模型并切换；
- 新建 QQ Agent 会话；
- 查看、搜索并恢复历史 QQ Agent 会话；
- 给会话命名；
- 压缩长会话；
- 中止当前长任务；
- 让后续 QQ 消息继续进入刚切换的会话；
- 本地 Pi 执行 `/new`、`/resume`、`/fork`、`/reload` 后，QQBot 仍在线；
- 主机暂时没有打开 Pi TUI 时，也能通过一个明确的常驻启动方式使用 QQBot。

### 2.2 明确不做的事情

本规划默认不实现以下高风险或语义不清的行为：

- 不从 QQ 控制主机正在使用的本地 TUI 会话；
- 不把 `/model`、`/new` 等文本直接传给模型，希望模型自行“执行”；
- 不从 QQ 执行 `/login`、`/logout`、`/theme`、`/quit`、`/reload` 等本地交互或进程级命令；
- 不允许任意 QQ 用户访问会话列表、模型列表或控制任务；
- 不把不同 QQ 用户默认混在同一个会话上下文；
- 不承诺宿主进程被退出、崩溃、休眠或断网后仍在线；常驻能力仍需要一个运行中的宿主进程或服务。

### 2.3 两类“会话”必须区分

为避免用户误解，产品文案与代码中必须使用明确术语：

- **本地会话**：用户电脑终端中当前可见的 Pi TUI 会话；
- **QQ 会话**：QQBot 专属、隔离的 AgentSession；
- **宿主进程**：持有 QQ WebSocket、QQ API 和 QQ AgentRuntime 的 Pi 进程；
- **QQ 对话作用域**：一个 QQ 私聊用户，或一个群聊上下文，对应的 QQ 会话归属。

`/new` 在 QQ 中只新建 **QQ 会话**，绝不切换本地会话。所有成功回复必须明确写出“QQ 会话”。

---

## 3. 现状审计与根因

### 3.1 当前命令并没有真正执行 Pi 内建命令

当前 `router.ts` 的命令逻辑有两层问题：

1. `BLOCKED_COMMANDS` 明确拒绝 `new`、`resume`、`model`、`compact` 等命令；
2. 即使 `allowCommands: true`，其他斜杠文本也只是通过 `QQAgentSession.run()` 调用 `session.prompt()`。

Pi 官方扩展文档明确说明：

- `pi.getCommands()` 只包含扩展命令、Prompt Template 和 Skill 命令；
- `/model`、`/new`、`/resume`、`/settings` 等是 Interactive Mode 内建命令；
- 这些内建命令不会因为把字符串传给 SDK `AgentSession.prompt()` 就自动执行。

因此，“把其他 `/` 开头输入交给隔离会话”不能满足切换模型或会话管理需求。根本解决方法是建立**显式命令路由 + Pi SDK 控制 API**。

### 3.2 QQ 会话是内存会话，无法恢复

当前 `qq-session.ts` 使用：

```ts
SessionManager.inMemory(cwd)
```

优点是隔离简单，但后果是：

- 宿主进程停止后历史消失；
- 无法列出 QQ 专属历史会话；
- 无法实现真正的 `/resume`；
- `/new` 只能清空内存，无法形成可恢复的历史记录。

要满足用户需求，应改成**QQ 专属持久化会话目录**，同时继续与本地 Pi 会话目录隔离。

### 3.3 网关绑定在本地会话生命周期

当前 `index.ts` 在每次 `session_shutdown` 中无条件执行：

```ts
await rt?.stop();
```

Pi 官方生命周期说明指出：本地 `/new`、`/resume`、`/fork`、`/clone`、`/reload` 都会先触发 `session_shutdown`，随后加载新扩展实例并触发新的 `session_start`。当前实现因此会：

1. 关闭 QQ WebSocket；
2. dispose 隔离 QQ session；
3. 清空队列；
4. 新扩展实例读取 `autoStart: false`；
5. 不重新连接。

这不是 QQ 平台问题，而是运行时所有权设计错误。

### 3.4 `autoStart` 只能缓解，不能根治

将 `autoStart` 改为 `true` 可以让每个新本地会话再次连接，但仍有缺点：

- 会话切换时产生不必要的断线和重连；
- 活跃 QQ 任务会被 abort；
- 队列和临时状态丢失；
- `/reload` 期间可能短暂重复启动；
- 不能解决 Pi TUI 进程退出后 QQBot 离线；
- 不能提供 QQ 侧 `/model`、`/new`、`/resume`。

所以 `autoStart: true` 只能作为当前版本的临时绕行措施，不是目标架构。

### 3.5 当前单全局 QQ 会话不适合多用户

现有 `PiQQBotRuntime` 只有一个 `qq?: QQAgentSession`，所有允许用户和群消息进入同一个 FIFO、同一个上下文。命令能力扩展后，这会导致：

- A 用户切换模型会影响 B 用户；
- A 用户可以恢复 B 用户的会话；
- 私聊和群聊上下文相互污染；
- 会话列表可能泄露其他用户的任务摘要。

命令优化必须同时定义会话作用域和授权边界，否则功能越强，风险越大。

---

## 4. 调研结论

### 4.1 Pi 官方能力结论

基于 Pi 官方本地文档、SDK 文档和官方仓库资料，可直接使用的能力包括：

- `AgentSession.setModel(model)`：切换当前隔离会话模型；
- `AgentSession.setThinkingLevel(level)`：修改思考等级；
- `AgentSession.compact()`：压缩当前会话；
- `AgentSession.abort()`：中止当前运行；
- `ModelRegistry.getAvailable()`：获取已配置认证的可用模型；
- `ModelRegistry.find(provider, modelId)`：按 provider/id 查找模型；
- `SessionManager.create()`：创建持久会话；
- `SessionManager.list()`：列出指定目录/工作目录会话；
- `SessionManager.open()`：打开持久会话；
- `createAgentSessionRuntime()` / `AgentSessionRuntime.newSession()` / `switchSession()`：官方支持的会话替换层；
- `AgentSessionRuntime` 会在替换后更换 `runtime.session`，订阅者必须重新绑定。

关键判断：**QQ 侧实现 `/new` 和 `/resume` 时，应升级为 AgentSessionRuntime，而不是手工 dispose 后拼装一个新 AgentSession。**

### 4.2 QQ 官方能力结论

QQ 官方文档提供以下可用交互基础：

- 单聊和群聊支持自定义 Markdown；
- Markdown 消息底部可挂自定义 Keyboard；
- Keyboard 最多 5 行，每行最多 5 个按钮；
- 指令按钮 `action.type = 2` 可把命令插入输入框；
- 单聊支持 `action.enter = true`，点击后可直接发送；
- `permission.type = 0` 的 `specify_user_ids` 要求平台用户 ID；C2C/群 v2 消息提供的 openid/member_openid 不能直接填入，否则手机 QQ 会提示“无权限操作”；本项目使用 `permission.type = 2`，并由服务端 allowlist/admin 再次鉴权；
- QQ 客户端输入 `/` 或 `@机器人` 可唤起管理端配置的指令面板；
- 单聊另有管理端“快捷菜单”；
- C2C 被动回复按较新公告采用 60 分钟最多 4 次；群聊被动回复窗口较短，应保持保守设计；
- 相同 `msg_id + msg_seq` 重复发送会失败。

因此移动端最佳方案不是让用户记住几十条命令，而是：

1. 少量稳定根命令；
2. `/help`、`/model`、`/resume` 无参数时返回短列表和按钮；
3. 按钮发送同一套文本命令，保证无按钮客户端也可操作；
4. 复杂选择支持编号、精确 ID 和按钮三种入口。

### 4.3 通用 ChatOps / 对话 UX 结论

来自 Slack、Google Chat、Discord、Telegram、Microsoft Bot Design 和 NN/g 的共同原则：

- 命令名应短、可预测、使用动作词；
- 无参数命令应该自解释，不能只返回“参数错误”；
- `/help` 应支持按命令查看详细用法；
- 常用操作应有按钮/菜单，移动端不应要求记忆 ID；
- 长任务要立即确认“已收到/处理中”，避免“神秘机器人”；
- 用户会随时改变主意，必须全局支持 `help`、`cancel/stop`、`start over/new`；
- 错误回复必须说明：发生了什么、没有发生什么、下一步怎么做；
- 破坏性或难撤销操作才确认，不能对每个安全操作都弹确认；
- 确认内容必须重述目标和后果，不能只问“确定吗？”；
- 参数解析要一致，常见路径短，高级能力渐进披露；
- 动态对象应支持自动完成/选择，而不是要求用户记忆内部 ID。

---

## 5. 总体设计原则

### P1. 命令由程序执行，prompt 由模型处理

- `/model`、`/new`、`/resume` 等由 CommandController 解析并直接调用 Pi SDK；
- 普通文本和附件进入 QQ Agent；
- 未知 `/xxx` 不得默认作为 prompt 执行，除非它是已验证的 Prompt Template/Skill 命令且配置明确允许。

### P2. QQ 控制 QQ 会话，不控制本地 TUI 会话

保持原有隔离承诺。QQ 侧命令只改变对应 QQ 会话的模型、历史和运行状态。

### P3. 网关生命周期属于宿主进程，不属于本地会话

本地 `/new` 和 `/resume` 是 UI/本地 Agent 行为，不应重启 QQ 网络层。

### P4. 状态先于动作

每个管理结果都给出当前状态与下一步，例如：

```text
已切换 QQ 会话模型
模型：anthropic/claude-sonnet-4-5
思考等级：high
会话：修复登录问题

继续发送问题即可。
```

### P5. 手机优先、按钮优先、文本可回退

按钮用于发现和选择；文本命令是稳定协议。两者必须进入同一解析器，不能出现两套逻辑。

### P6. 安全默认拒绝

- 管理命令默认只允许私聊；
- 群聊即使在 `allowGroups` 中，也不自动获得模型/会话管理权限；
- 会话与身份绑定；
- `/login` 永不远程开放；
- 敏感错误不返回密钥、绝对 session path 或内部栈。

### P7. FIFO 只序列化 Agent 运行，不阻塞只读命令

- `/status`、`/model`（查看）、`/sessions` 可快速响应；
- 会改变 session/model 的命令通过每个作用域的 ControlLock 串行化；
- 普通 prompt 通过每个作用域的 AgentQueue 串行化；
- `/stop` 有高优先级，可中止当前作用域运行。

### P8. 幂等与可恢复

重复 QQ 事件、重复按钮点击和超时重试不能重复创建会话或重复切换。所有变更命令必须带命令事务 ID，并维护短期结果缓存。

---

## 6. 目标架构

### 6.1 分层结构

```text
QQ WebSocket / HTTP API
        │
        ▼
GatewayHost（进程级常驻）
  - QQAuth / QQGateway / QQApi
  - reconnect / heartbeat
  - inbound dedupe
  - runtime registry
        │
        ▼
InboundRouter
  ├─ 普通文本/附件 ───────────────┐
  ├─ 斜杠命令 ──> CommandParser   │
  └─ 指令按钮 ──> 同一 CommandParser│
                                   ▼
                          ConversationRegistry
                   key = private:user_openid
                      或 group:group_openid
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                   ▼
          CommandController                    QQAgentController
     model/session/status/stop          AgentSessionRuntime + queue
                 │                                   │
                 └─────────────────┬─────────────────┘
                                   ▼
                          ReplyComposer / Keyboard
                                   │
                                   ▼
                          QQ passive reply API
```

### 6.2 进程级 GatewayHost

`GatewayHost` 是解决“本地新会话后掉线”的核心。

要求：

- 在同一宿主 Pi 进程内只有一个实例；
- 扩展重新实例化时，通过 `globalThis[Symbol.for(...)]` 或独立 Host Registry 重新取得同一实例；
- 使用引用/租约模型，而不是每个 `session_shutdown` 都 stop；
- `session_shutdown.reason` 为 `new`、`resume`、`fork`、`reload` 时进入 handoff grace period，不立即关闭；
- 新扩展实例在 `session_start` 重新 attach；
- grace period 到期且没有新 owner 时才真正 stop；
- `quit` 时立即或短延迟完整清理；
- 开发模式 `/reload` 必须校验代码版本，必要时执行受控 runtime replacement，避免旧代码永久驻留。

建议状态机：

```text
stopped -> starting -> running -> handoff -> running
                         │             │
                         └-> stopping <-┘
                               │
                            stopped/error
```

### 6.3 真正常驻模式

仅靠“跨本地会话 handoff”不能覆盖宿主 Pi 进程退出。规划提供两个运行级别：

#### Level A：进程内常驻（v0.4.0 必做）

- Pi 进程运行期间，本地 `/new`、`/resume`、`/fork`、`/reload` 不断开；
- 适合用户保留一个 Pi TUI/RPC 宿主。

#### Level B：无 TUI 服务模式（v0.4.x/v0.5.0）

- 提供 `pi-qqbot serve` 或官方支持的 Pi RPC/SDK host entry；
- 由 systemd user service、launchd、Windows Task Scheduler/NSSM 或用户自己的 tmux 管理；
- 不依赖打开交互式 TUI；
- TUI 仅作为可附加的观察器；
- 任何时刻只允许一个实例持有同一 appId 的 Gateway lease，防止多登录/重复回复。

重要：守护化必须是明确命令和文档，不应由扩展静默创建系统服务。

### 6.4 ConversationRegistry 与作用域隔离

建议默认：

```text
private:<user_openid>              -> 独立 QQ AgentRuntime
 group:<group_openid>              -> 独立 QQ AgentRuntime（共享群上下文）
```

管理命令授权建议：

- 私聊：`allowUsers` 中用户可使用；
- 群聊：默认只允许 `/status`、`/help`、`/stop`；
- 群管理命令需同时满足：群在 `allowGroups`，发送者在 `commandAdmins`，且 `commands.allowInGroups = true`；
- 群会话恢复列表只显示该群会话，不显示私聊或其他群。

每个 scope 包含：

```ts
interface ConversationRuntime {
  key: string;
  cwd: string;
  agentRuntime: AgentSessionRuntime;
  queue: MessageQueue;
  controlLock: AsyncMutex;
  activeRun?: ActiveRun;
  lastUsedAt: number;
  commandState: PendingCommandState;
}
```

空闲 runtime 可做 LRU 释放，但持久 session 文件保留，下一条消息自动恢复最近会话。

### 6.5 QQ 专属持久化会话

推荐会话目录：

```text
~/.pi/agent/qqbot/sessions/<scope-hash>/
```

要求：

- 不使用本地 Pi 默认 `sessions/` 目录，避免 `/resume` 混入本地记录；
- scope 目录使用 HMAC/SHA-256 截断，不直接暴露 openid；
- 创建 `SessionManager.create(cwd, scopeSessionDir)`；
- 启动时使用 `SessionManager.continueRecent(cwd, scopeSessionDir)`；
- `/new` 调用 `AgentSessionRuntime.newSession()`；
- `/resume` 先 `SessionManager.list(cwd, scopeSessionDir)`，再 `switchSession(path)`；
- 回复只显示短 session id、会话名、时间和首条消息摘要，不显示绝对路径；
- 默认保留最近 N 个会话，可配置归档策略，但不得自动永久删除。

### 6.6 AgentSessionRuntime 创建方式

升级 `QQAgentSession` 为 `QQAgentController`，内部使用 Pi 官方 runtime 层：

```ts
const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getAgentDir(),
    resourceLoaderOptions: { noExtensions: true },
  });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};
```

必须保持：

- `noExtensions: true`，防止隔离会话再次加载 pi-qqbot；
- 使用 Pi 正常 AuthStorage、ModelRegistry、SettingsManager；
- 每次 runtime replacement 后重新绑定 AgentSession 事件订阅；
- `runtime.dispose()` 完整清理；
- 失败时不回退到本地 session。

---

## 7. 命令信息架构

### 7.1 根命令设计

建议公开 10 个核心命令，避免菜单过长：

| 命令 | 作用 | 无参数行为 | 风险级别 |
|---|---|---|---|
| `/help [command]` | 帮助与主菜单 | 显示核心命令和快捷按钮 | 只读 |
| `/status` | 查看连接、运行、模型、会话、队列 | 直接显示 | 只读 |
| `/model [query]` | 查看或切换 QQ 模型 | 显示当前模型和最近/推荐模型 | 状态变更 |
| `/thinking [level]` | 查看或设置思考等级 | 显示当前等级和可选值 | 状态变更 |
| `/new [name]` | 新建 QQ 会话 | 创建新会话；活跃任务时先提示 | 状态变更 |
| `/sessions [query|page]` | 列出/搜索 QQ 会话 | 最近 5 个 | 只读 |
| `/resume <index|id>` | 恢复 QQ 会话 | 无参数时等同 `/sessions` | 状态变更 |
| `/name <text>` | 给当前 QQ 会话命名 | 显示当前名称与用法 | 状态变更 |
| `/compact [instruction]` | 压缩当前 QQ 会话 | 使用默认压缩指令 | 长操作 |
| `/stop` | 中止当前 QQ 任务并清理待确认操作 | 空闲时返回“当前没有任务” | 高优先级 |

兼容别名：

- `/qqbot-help` -> `/help`
- `/qqbot-status` -> `/status`
- `/qqbot-last` -> `/last`（可保留为诊断命令，不放主菜单）
- `/cancel` -> `/stop`
- 中文自然别名可通过按钮或解析层提供，但文档中的 canonical command 只保留英文小写。

### 7.2 不远程开放的命令

| 命令 | 原因 | QQ 回复建议 |
|---|---|---|
| `/login`, `/logout` | 涉及凭据/OAuth/设备交互 | “认证只能在受信任主机上完成；完成后可在 QQ 使用 `/model`。” |
| `/theme`, `/settings` | TUI 专属或设置范围过大 | 提供具体安全子命令，如 `/thinking` |
| `/quit`, `/exit` | 会关闭宿主，造成远程失联 | 不支持；服务停机必须在主机完成 |
| `/reload` | 会替换扩展代码和资源，远程风险高 | 默认不支持；后续可设计管理员专用带确认命令 |
| `/tree`, `/fork`, `/clone` | 需要复杂分支选择 UI | v0.4.0 不做；后续在有稳定分页/选择后开放 |
| `!shell` / `!!shell` | 绕过 Agent 审批与语义层的直接远程执行 | 永久禁止 |

注意：普通自然语言仍可能让 Agent 使用 bash 工具，这是插件既有能力，应由 allowlist、工作目录、容器/权限策略控制；但不能再增加一条不经过 Agent 的原始 shell 通道。

### 7.3 命令语法规范

统一语法：

```text
/<verb> [primary-argument] [--option value]
```

v0.4.0 只实现必要参数，避免过早设计复杂 CLI。解析规则：

- 命令名 ASCII 小写，不区分用户输入大小写；
- 参数支持首尾空格清理和带引号字符串；
- `--help` 与 `help` 均显示子命令帮助；
- 未知参数不忽略，返回精确错误和示例；
- 不做模糊切换：模型 query 多匹配时必须让用户选择；
- 会话可用当前列表序号、短 ID 或唯一名称恢复；
- 序号只在短期选择上下文中有效，过期后要求重新 `/sessions`；
- 命令最大长度、参数数量和 query 长度设硬上限。

### 7.4 模型命令交互

#### 查看

```text
/model
```

回复：

```markdown
## 当前 QQ 模型

**anthropic/claude-sonnet-4-5**
- 输入：文本、图片
- 思考等级：high

可直接发送：
`/model openai/gpt-5.2`
```

按钮（单聊）：

```text
[切换模型] [思考等级]
[刷新列表] [返回帮助]
```

#### 搜索/选择

```text
/model sonnet
```

- 0 个结果：说明没有可用认证或 query 不匹配，并提示 `/model`；
- 1 个精确/唯一结果：切换并确认；
- 多个结果：显示最多 5 个，编号 + 按钮；
- 只列 `modelRegistry.getAvailable()`，不把无认证模型包装成可选项；
- 可附加能力标记：`🖼` 视觉、`🧠` reasoning；
- 切换使用 `AgentSession.setModel(model)`；
- 成功后持久化 model change，后续 `/new` 继承默认/当前模型策略需明确。

建议继承策略：新会话默认沿用当前 QQ scope 的模型和思考等级，符合用户“换模型后继续工作”的预期。

### 7.5 新建会话

```text
/new
/new 修复支付回调
```

行为：

1. 当前空闲：立即通过 `AgentSessionRuntime.newSession()` 创建；
2. 当前运行中：不静默 abort，回复：

```text
当前任务仍在执行。
发送 /stop 后再 /new，或点击“停止并新建”。
```

3. 如果启用两步确认按钮，“停止并新建”必须显示后果：当前生成会中止，但已有会话历史仍保存；
4. 新会话成功后设置可选名称；
5. 回复当前模型、cwd、会话短 ID 和下一步“直接发送任务即可”。

`/new` 不删除旧会话，因此通常不需要确认；只有它隐含中止活跃任务时才需要确认。

### 7.6 会话列表与恢复

```text
/sessions
/sessions 登录
/resume 2
/resume a1b2c3d4
```

列表卡片：

```markdown
## QQ 会话

1. **修复登录问题** · 当前
   `a1b2c3d4` · 今天 14:32 · 18 条消息
2. **依赖升级**
   `c3d4e5f6` · 昨天 21:10 · 9 条消息

发送 `/resume 2` 恢复；`/sessions 2` 查看下一页。
```

规范：

- 每页 5 条，避免 QQ 长消息；
- 排序按 modified 降序；
- `query` 搜索 name、firstMessage、allMessagesText，但返回摘要必须去敏；
- 当前会话标注“当前”；
- 恢复当前会话为幂等成功；
- 恢复前等待当前 Agent idle；若运行中要求先 `/stop`；
- 通过 `AgentSessionRuntime.switchSession(path)` 切换；
- 校验 path 必须来自当前 scope 的 `SessionManager.list()` 结果，绝不接受任意文件路径；
- 会话切换成功后重新绑定事件订阅、刷新状态和模型信息。

### 7.7 思考等级

```text
/thinking
/thinking high
```

允许：`off|minimal|low|medium|high|xhigh`。只显示当前模型支持的等级；调用 `session.setThinkingLevel()`，并明确反馈可能被模型能力 clamp 的最终等级。

### 7.8 压缩与终止

`/compact [instruction]`：

- 长操作立即回复“已开始压缩 QQ 会话”；
- 完成后回复压缩前后摘要；
- 失败时说明会话未被替换/历史仍保留；
- 与 prompt 串行，不能边执行工具边 compact。

`/stop`：

- 高优先级，直接调用当前 scope `session.abort()`；
- 清除该 scope 队列中的待执行 prompt（是否清除全部必须配置，默认只清当前运行、保留后续队列并询问）；
- 清除 pending confirmation；
- 回复“已停止当前 QQ 任务；会话历史已保留”；
- 不能停止其他用户/群 scope 的任务。

---

## 8. 按钮、菜单与渐进披露

### 8.1 QQ 管理端指令面板

在 QQ 机器人管理端配置最小命令集：

```text
/help      查看帮助与快捷操作
/status    查看 QQ Agent 状态
/model     查看或切换模型
/new       新建 QQ 会话
/sessions  查看历史 QQ 会话
/stop      停止当前任务
```

不要把所有高级命令都塞进面板。`/thinking`、`/resume`、`/compact`、`/name` 从帮助页逐步展示。

### 8.2 自定义 Keyboard

优先使用**指令按钮**而不是回调按钮作为第一阶段：

- 指令按钮最终生成正常 QQ 消息事件，复用现有 allowlist、dedupe 和被动回复链路；
- 单聊可用 `enter: true` 一键发送；
- 群聊 `enter` 不保证可用，按钮只填入命令让用户确认；
- 使用 `permission.type = 2` 允许当前会话成员触发指令按钮；不能把 v2 `user_openid/member_openid` 当成 `specify_user_ids`，所有按钮产生的命令仍必须经过服务端 allowlist/admin 鉴权；
- 每页不超过 2–3 行，每行 2 个按钮，避免 5×5 密集键盘；
- 每个按钮 `unsupport_tips` 提供文本命令回退。

示例帮助键盘：

```text
[当前状态] [切换模型]
[新建会话] [历史会话]
[停止任务] [更多帮助]
```

模型选择键盘：

```text
[1 Sonnet] [2 GPT]
[3 Gemini] [下一页]
[返回]
```

### 8.3 回调按钮作为后续增强

如果实现 callback action，则必须：

- 订阅 QQ `INTERACTION` intent，并确认机器人账号具备权限；
- 处理 `INTERACTION_CREATE`/平台实际事件结构；
- 使用 `event_id` 回应交互；
- 验证点击者、原消息 owner、按钮 nonce、TTL 和一次性语义；
- callback data 只放随机 token，不放 openid、路径、模型密钥或完整命令；
- 无权限时拒绝而不是静默执行。

考虑到 QQ 文档提示特殊 intent 可能需要申请，v0.4.0 建议先用 `action.type = 2` 指令按钮，以降低接入风险。

---

## 9. 生命周期优化规范

### 9.1 本地会话替换

收到扩展 `session_shutdown`：

| reason | GatewayHost 行为 | TUI Observer 行为 | QQ Agent 行为 |
|---|---|---|---|
| `new` | 保持连接，进入短 handoff | detach 旧视图 | 保持 |
| `resume` | 保持连接，进入短 handoff | detach 旧视图 | 保持 |
| `fork` | 保持连接，进入短 handoff | detach 旧视图 | 保持 |
| `reload` | 保持连接或受控热替换 | detach，等待新实例 attach | 尽量保持；不兼容升级时重建并恢复 |
| `quit` | 完整 stop | dispose | flush + dispose |

新 `session_start`：

- 新扩展实例 attach 到 GatewayHost；
- 更新可选 terminal observer；
- 不重复创建 QQAuth/QQGateway；
- 如果 Host 不存在且配置 `autoStart`/`hostMode` 允许，则启动；
- 如果 Host 存在但配置 hash 改变，执行明确的 config reconciliation。

### 9.2 配置变更处理

配置分为：

- **热更新字段**：allowlist、命令权限、回复格式、按钮开关、队列上限（可安全应用）；
- **需重连字段**：appId、clientSecret、sandbox；
- **需重建 AgentRuntime 字段**：sessionMode、cwd policy、resource policy。

`/reload` 后比较 config hash：

- 无变化：只 reattach；
- 热更新：原子替换配置；
- 需重连：完成当前回复后受控 reconnect；
- 需重建：flush 当前 QQ 会话、重建 runtime、恢复最近 session；
- 任何失败保留旧可用 runtime，不能先销毁后发现新配置无效。

### 9.3 启动策略

调整配置语义：

```json
{
  "enabled": true,
  "startup": {
    "mode": "auto",
    "keepAcrossLocalSessions": true,
    "handoffGraceMs": 10000
  }
}
```

建议：

- `enabled: true` 且 `startup.mode: "auto"`：Pi 宿主启动即连接；
- `manual`：保留 `/qqbot-start`；
- `service`：期望由无 TUI host 启动，普通 TUI 只 attach observer；
- 兼容旧 `autoStart`，启动时迁移/映射并给出弃用提示。

用户的目标场景推荐默认 `auto`；安全仍依赖 allowlist 为空时不处理消息，而不是通过默认不连接实现。

---

## 10. 配置规范

建议新增：

```json
{
  "commands": {
    "enabled": true,
    "allowInGroups": false,
    "admins": [],
    "buttons": true,
    "maxListItems": 5,
    "selectionTtlMs": 300000,
    "confirmationTtlMs": 120000
  },
  "sessions": {
    "mode": "persistent",
    "scope": "conversation",
    "restore": "recent",
    "maxResident": 8,
    "idleDisposeMs": 1800000
  },
  "startup": {
    "mode": "auto",
    "keepAcrossLocalSessions": true,
    "handoffGraceMs": 10000
  }
}
```

字段说明：

- `commands.enabled`：是否开放 QQ 管理命令；建议替代语义模糊的 `allowCommands`；
- `commands.allowInGroups`：群聊是否可执行状态变更命令；默认 false；
- `commands.admins`：可执行管理命令的私聊 user_openid / 群 member_openid；必须显式加入，空数组表示没有管理员，普通 `allowUsers` 不自动继承；
- `commands.buttons`：发送 QQ Keyboard；不支持时文本命令可回退；
- `sessions.mode`：`persistent` 或 `memory`；满足本需求必须是 `persistent`；
- `sessions.scope`：首版只支持 `conversation`；
- `sessions.restore`：`recent|new`；默认 recent；
- `maxResident`：最多同时驻留的 ConversationRuntime；
- `idleDisposeMs`：空闲释放内存，但不删除 session 文件；
- `startup.mode`：`auto|manual|service`；
- `handoffGraceMs`：本地 session replacement 的所有权交接窗口。

兼容迁移：

- 旧 `allowCommands: false` -> `commands.enabled: false`；
- 旧 `allowCommands: true` 不应自动开放全部新管理命令，应映射为 info-only 并提示用户显式确认；
- 旧 `autoStart` -> `startup.mode`；
- 至少保留一个小版本的兼容读取和状态警告。

---

## 11. 安全模型

### 11.1 权限分级

| 级别 | 能力 | 默认主体 |
|---|---|---|
| L0 | 普通 prompt/附件 | allowUsers / allowGroups |
| L1 | status/help/model list/session list | 私聊 allowUsers |
| L2 | model switch/new/resume/name/thinking/compact/stop | command admins |
| L3 | reconnect/reload/service stop/config | 默认不从 QQ 开放 |

无论单人还是多人场景，L2 管理权限都必须显式写入 `commands.admins`；`allowUsers` 只授予普通使用权限。

### 11.2 会话访问控制

- session path 只能由 scope 内部索引解析；
- 不接受 `/resume /absolute/path.jsonl`；
- 不跨 scope 搜索；
- 群成员只能访问群 scope 会话；
- 私聊用户只能访问自己的 scope；
- 状态输出不暴露完整 openid、绝对路径、auth 状态详情和 token。

### 11.3 按钮安全

- 指令按钮限定当前用户；
- 选择 token 有 TTL；
- 选择上下文绑定 `scope + user + original message + command type`；
- 按钮点击/命令消息仍走 allowlist；
- 重复事件由 msg_id dedupe；
- 回调按钮若实现，nonce 单次消费。

### 11.4 危险动作确认

需要确认：

- 活跃任务中执行“停止并新建”；
- 未来可能增加的 session 删除；
- 远程 reload/restart/service stop（若未来开放）；
- 会影响他人共享群会话的清空或切换。

不需要确认：

- 查看状态/列表；
- 空闲时新建会话；
- 切换模型；
- 恢复历史会话（历史不丢失）；
- 修改思考等级。

确认文案必须明确目标和后果：

```text
将停止“依赖升级”中的当前生成，并新建 QQ 会话。
已有历史仍会保存。

发送：/confirm 7K2M
取消：/cancel
```

禁止仅回复“确定吗？”。

### 11.5 审计

写入结构化、最小化审计日志：

```ts
{
  at,
  scopeHash,
  actorHash,
  command: "model",
  outcome: "success" | "denied" | "error",
  target?: "provider/model-id",
  latencyMs,
  correlationId
}
```

不得记录：clientSecret、access token、附件 URL、完整 prompt、完整 session path。

---

## 12. 并发、队列与事务

### 12.1 每作用域双通道

- `AgentQueue`：普通消息与需要 LLM 的操作；
- `ControlQueue`：会话/模型状态变更；
- `stop`：高优先级旁路。

规则：

1. 同一 scope 最多一个 agent run；
2. model/new/resume/compact 在 agent idle 后执行；
3. 只读 status/list 可并行读取快照；
4. 不同 scope 可并行，但设置全局并发上限，避免资源耗尽；
5. 全局 Gateway FIFO 不再成为所有用户互相阻塞的瓶颈。

### 12.2 命令事务

每条状态变更命令：

```text
received -> validated -> waiting_idle -> applying -> committed -> replied
                                  └-> failed/rolled_back
```

- `msg_id` 作为外部幂等键；
- 同一 msg_id 重复到达返回缓存结果或忽略；
- session replacement 先验证目标、创建新 runtime 成功，再替换引用；
- 模型切换失败时保持旧模型；
- 配置 reload 失败保持旧 Host。

### 12.3 长操作反馈

受 QQ 被动回复限制，首条响应预算必须保守。命令层建议：

- 快速命令目标 2 秒内完成；
- 超过 2 秒发送“已开始”；
- 保留至少 1 个被动回复名额用于最终结果；
- 单次命令正常最多 2 条消息：ack + result；
- 群聊窗口短，compact 等长操作提示可能超时，并优先在私聊执行。

---

## 13. 错误与回复规范

统一错误格式：

```markdown
## 未切换模型

找到 3 个匹配项，无法确定你要使用哪一个。

1. `anthropic/claude-sonnet-4-5`
2. `openrouter/anthropic/claude-sonnet-4.5`
3. `custom/sonnet-local`

发送 `/model 1`，或输入完整的 `provider/model`。
```

每条错误包含：

1. **结果**：做成了还是没做成；
2. **原因**：用户可理解、不过度泄露；
3. **系统状态**：旧模型/旧会话是否仍有效；
4. **恢复动作**：一条可复制的命令或按钮。

典型错误：

| 场景 | 回复要点 |
|---|---|
| 模型无认证 | 未切换；旧模型继续；请在主机 `/login` 后重试 |
| 多模型匹配 | 未切换；给编号选择 |
| session 不存在 | 未切换；重新 `/sessions` |
| 选择上下文过期 | 未执行；重新打开列表 |
| 当前任务运行中 | 未切换/新建；先 `/stop` |
| 权限不足 | 不披露目标详情；提示仅管理员可用 |
| QQ Markdown/按钮失败 | 回退纯文本；命令仍可复制 |
| Gateway disconnected | status 显示重连状态；不要声称命令已执行 |
| runtime replacement 失败 | 保留旧 session；提供 correlation id |

---

## 14. 状态与可观察性

`/status` 推荐输出：

```markdown
## QQ Agent 状态

- 连接：已连接
- 会话：`修复登录问题` (`a1b2c3d4`)
- 模型：`anthropic/claude-sonnet-4-5`
- 思考：`high`
- 工作目录：`project-name`
- 当前任务：空闲
- 等待消息：0
- 历史模式：持久化
- 宿主模式：进程内常驻

最后重连：今天 14:21
```

主机 `/qqbot-status` 额外显示：

- Host generation / owner count；
- 运行模式和 handoff 状态；
- resident scope 数量；
- 当前 active run 数；
- 配置 hash（短）；
- 最近命令错误码；
- service lease owner；
- 但不显示密钥或完整用户标识。

终端视图是 observer，不再决定 runtime 是否存在。新 TUI 会话自动 attach（可配置），无需再次 `/qqbot-start`。

---

## 15. 文件与模块规划

建议拆分，避免继续膨胀 `router.ts`：

```text
index.ts                       扩展命令注册、Host attach/detach
host-registry.ts               进程级单例、租约、handoff
qq-host.ts                     QQAuth/Gateway/API 生命周期
conversation-registry.ts       scope runtime、LRU、并发上限
qq-agent-runtime.ts            AgentSessionRuntime 封装
command-parser.ts              纯函数解析、语法、别名
command-controller.ts          权限、调度、命令执行
command-catalog.ts             元数据、help、示例、风险级别
command-replies.ts             移动端 Markdown/纯文本布局
qq-keyboard.ts                 Keyboard 构建与权限绑定
session-store.ts               QQ 专属目录、列表、搜索、短 ID
selection-store.ts             编号选择/确认 token TTL
command-audit.ts               最小审计
router.ts                      入站分流，不再承载全部职责
```

现有文件调整：

- `qq-session.ts`：迁移为 runtime 封装或保留兼容层；
- `qq-api.ts`：支持 Markdown + Keyboard payload；
- `qq-gateway.ts`：保持消息 intent；若后续 callback 再增加 interaction intent；
- `types.ts`：新增 command/session/startup 配置和 runtime 类型；
- `config.ts`：严格归一化、迁移和硬上限；
- `terminal-view.ts`：从 Host 订阅，不拥有 Host；
- `README.md`、示例配置：说明 QQ 会话与本地会话的区别。

---

## 16. 分阶段实施计划

### Phase 0：契约测试与基线固化

目标：在重构前冻结现有富媒体、回复、allowlist、安全行为。

任务：

- 为 `handleCommand`、queue、dedupe、附件、QQ API payload 建 fixture；
- 增加生命周期模拟：startup -> new shutdown/start -> resume -> reload -> quit；
- 记录现有资源清理断言；
- 建立 fake SDK/runtime 接口，避免测试依赖真实模型。

验收：现有功能测试全部可重复运行。

### Phase 1：命令内核（先可用）

目标：在现有隔离 session 上先支持 `/status`、`/model`、`/thinking`、`/stop`。

任务：

- 新增 parser/catalog/controller；
- 删除“任意斜杠交给模型”的错误语义；
- 模型查找、唯一匹配、列表与切换；
- 思考等级；
- 高优先级 abort；
- 帮助和错误规范；
- `commands.enabled/admins` 配置。

验收：用户无需主机即可切换 QQ Agent 模型。

### Phase 2：持久 QQ 会话

目标：实现 `/new`、`/sessions`、`/resume`、`/name`、`/compact`。

任务：

- `SessionManager.inMemory` -> QQ 专属持久 SessionManager；
- 封装 AgentSessionRuntime；
- runtime replacement 重新订阅；
- 每 scope 会话目录；
- 短 ID/编号/分页/搜索；
- 活跃任务与 session switch 互斥；
- LRU runtime 释放。

验收：宿主重启后能恢复最近 QQ 会话；历史可从 QQ 选择。

### Phase 3：GatewayHost 生命周期

目标：本地 `/new`、`/resume`、`/fork`、`/reload` 后 QQ 不断开。

任务：

- 进程级 Host Registry；
- attach/detach lease；
- shutdown reason 分类；
- handoff grace；
- config reconciliation；
- TUI observer 自动重新 attach；
- quit 完整 cleanup；
- 防双实例 lease。

验收：本地连续切换会话与 reload，QQ 仍可发消息且活跃 QQ 会话保持。

### Phase 4：QQ 原生操作面

目标：降低移动端输入成本。

任务：

- QQ API Keyboard；
- `/help` 主菜单；
- 模型和 session 分页按钮；
- 指定用户权限；
- 文本回退；
- 文档指导管理端配置指令面板/快捷菜单。

验收：用户可以主要靠点击完成模型与会话操作。

### Phase 5：无 TUI 服务模式

目标：主机没有交互式 Pi 会话时 QQBot 仍工作。

任务：

- SDK/RPC service entry；
- 前台 `serve` 命令；
- systemd/launchd/Windows 示例（仅文档/模板，用户显式安装）；
- 健康检查、PID/lock、优雅停止；
- TUI attach observer 或状态客户端。

验收：重启机器后按用户配置自动启动；没有 TUI 也可 QQ 对话。

---

## 17. 测试规划

### 17.1 单元测试

- 命令大小写、空格、引号、别名、未知参数；
- 模型 0/1/N 匹配；
- 模型认证不可用；
- thinking clamp；
- session 短 ID 冲突；
- session 分页和搜索；
- scope key 与目录 hash；
- selection/confirmation TTL；
- 权限矩阵；
- Keyboard payload 与 user permission；
- Markdown/纯文本回退；
- 命令长度和参数上限。

### 17.2 集成测试

- `newSession()` 后新旧历史隔离；
- `switchSession()` 后模型/思考/消息恢复；
- runtime replacement 后事件订阅只触发一次；
- 模型切换失败保持旧模型；
- active run + `/stop`；
- active run + `/new` 拒绝；
- QQ msg_id 重推不重复建 session；
- 两个私聊 scope 不共享上下文/模型；
- 群与私聊不共享会话；
- LRU dispose 后再次恢复最近会话；
- 附件 cleanup 不受 session switch 破坏。

### 17.3 生命周期测试

逐一模拟：

```text
startup
  -> local /new
  -> local /resume
  -> local /fork
  -> local /reload (same config)
  -> local /reload (hot config)
  -> local /reload (reconnect config)
  -> quit
```

断言：

- 前六步 Gateway socket 数量始终为 1；
- 不重复注册 inbound handler；
- QQ Agent 当前 session ID 不变（除非 QQ 命令主动切换）；
- quit 后 socket/timer/subscription/temp workspace 全部为 0。

### 17.4 真实 QQ E2E

私聊：

- `/help` 按钮；
- `/model` 列表、精确切换、多匹配；
- 视觉模型/非视觉模型切换后图片行为；
- `/new` 后旧问题不进入上下文；
- `/sessions` + `/resume`；
- `/stop` 中止长任务；
- Markdown/Keyboard 被拒绝时纯文本可操作；
- QQ 客户端不支持按钮时复制命令成功。

群聊：

- 非管理员管理命令拒绝；
- 管理员命令按配置工作；
- 按钮权限绑定；
- 5 分钟窗口下长任务提示；
- 群 scope 不泄露私聊 session。

主机：

- QQ 正在运行时本地 `/new`；
- 本地 `/resume` 到不同 cwd（首版应保持 QQ 配置 cwd，或按明确 policy 行为）；
- `/reload`；
- 网络断开恢复；
- 宿主进程退出后 service 模式接管/明确离线。

### 17.5 安全测试

- 任意 `/resume ../../...`；
- 伪造 session ID；
- 其他用户使用旧编号；
- 复制他人按钮；
- 重放 callback nonce；
- 群成员冒充 admin；
- prompt 注入要求输出 session path/auth；
- `/login`、`/quit`、`!rm -rf`；
- 并发 model/new/resume；
- 配置 reload 期间消息到达；
- 多宿主实例竞争同 appId lease。

---

## 18. 验收标准

### 18.1 功能验收

- [ ] QQ 私聊可查看并切换隔离 QQ Agent 模型；
- [ ] QQ 私聊可新建、列出、恢复、命名和压缩 QQ 会话；
- [ ] QQ 可中止当前任务；
- [ ] QQ 历史在宿主重启后仍可恢复；
- [ ] 本地 Pi `/new`、`/resume`、`/fork`、`/reload` 无需再次 `/qqbot-start`；
- [ ] TUI 只作为 observer，attach/detach 不影响 QQ 运行；
- [ ] 不同 QQ scope 默认不共享会话和模型；
- [ ] 按钮不可用时所有流程均可通过文本命令完成。

### 18.2 安全验收

- [ ] 远程命令不能控制本地 TUI session；
- [ ] 远程不能执行 login/logout/quit/reload/raw shell；
- [ ] 所有状态变更命令经过 actor + scope 授权；
- [ ] session path 无法由用户直接指定；
- [ ] 重放不会重复执行；
- [ ] 不泄露密钥、token、附件 URL、绝对 session path；
- [ ] stop/quit/reload 后资源清理完整。

### 18.3 UX 验收

- [ ] 用户从 `/help` 在两次点击/命令内到达模型、新会话、历史会话、停止任务；
- [ ] 无参数命令都能自解释；
- [ ] 错误都给出下一条可执行命令；
- [ ] 成功回复明确说明作用对象是“QQ 会话”；
- [ ] 手机端单页列表不超过 5 项，主按钮不超过 3 行；
- [ ] 危险确认明确目标和后果，不使用模糊“确定吗？”；
- [ ] 长操作及时确认，不让用户判断机器人是否失联。

### 18.4 可靠性验收

- [ ] 本地 session replacement 期间只有一个 QQ Gateway；
- [ ] 多 scope 并发无串回复；
- [ ] AgentRuntime replacement 不产生重复订阅；
- [ ] 配置变更失败保留旧可用 runtime；
- [ ] QQ 被动回复遵守 msg_id/msg_seq 与保守分块预算；
- [ ] `npm audit --omit=dev` 无高危漏洞；
- [ ] strict TypeScript、构建、fixtures、真实 QQ E2E 通过。

---

## 19. 迁移与发布策略

### 19.1 版本策略

该变更包含持久化模型、生命周期和命令语义升级，建议发布 `v0.4.0`，不要作为 `v0.3.x` 无提示替换。

### 19.2 数据迁移

- v0.3.x 使用内存 QQ session，没有可迁移历史；升级后从第一个持久 QQ 会话开始；
- 原 allowlist 保留；
- 原 `replyFormat`、media 配置保留；
- 原 `allowCommands` 与 `autoStart` 进入兼容映射并显示一次迁移提示；
- 新会话目录权限设为仅当前用户可读写；
- 回滚到 v0.3.x 不删除 v0.4.0 session 文件。

### 19.3 发布前置条件

- README 明确“QQ 会话 ≠ 本地会话”；
- 提供升级示例配置；
- 提供管理端指令面板配置清单；
- 服务模式单独标注实验/稳定级别；
- Release Notes 列出远程控制安全变化；
- 不默认把群聊升级为管理权限。

---

## 20. 风险与替代方案

### 风险 A：进程级单例跨 reload 保留旧代码

缓解：Host 带 generation/schemaVersion；新实例发现不兼容时执行受控替换，旧 Host 只有在新 Host 验证可启动后释放。

### 风险 B：一个 runtime 每用户造成资源上升

缓解：`maxResident`、LRU、全局并发上限、idle dispose；会话文件持久化，按需恢复。

### 风险 C：持久 QQ session 扩大本地数据留存

缓解：独立目录、权限 0700/0600、可配置保留策略、明确文档；不自动上传。

### 风险 D：QQ Keyboard/Interaction 能力因账号权限差异失败

缓解：文本命令是权威协议；Keyboard 为增强层；首期使用指令按钮，不强依赖 interaction intent。

### 风险 E：用户误以为控制的是本地终端会话

缓解：命令回复始终写“QQ 会话”；`/status` 同时显示 scope；帮助中明确隔离边界。

### 风险 F：模型切换改变全局 Pi 默认模型

Pi `AgentSession.setModel()` 可能通过 SettingsManager 持久化 default model。实现时必须决定并测试：

- 推荐使用 QQ Agent 专属 in-memory/overlay SettingsManager，使模型变更只写 QQ session 的 model_change，不修改本地主机全局默认；
- 若 SDK 当前强耦合保存默认值，应为 QQ runtime 提供隔离 SettingsManager 存储；
- 验收测试必须断言：QQ `/model` 后新开的本地 Pi 会话默认模型不被意外改变。

这是实施中的关键技术门槛，不能遗漏。

### 风险 G：宿主彻底退出仍会离线

缓解：明确区分 Level A 与 Level B；为真正远程使用提供 `serve` + OS service 文档，而不是声称扩展能在无进程时运行。

---

## 21. 决策记录

### ADR-01：保留隔离，不接管本地 TUI

**决定**：QQ 命令只管理 QQ 专属 AgentRuntime。
**理由**：避免本地会话污染、并发冲突、终端交互死锁和意外远程操作。
**代价**：用户不能从 QQ 继续主机屏幕上那条本地会话；需要明确产品文案。

### ADR-02：采用 AgentSessionRuntime

**决定**：会话替换使用 Pi 官方 runtime 层。
**理由**：官方明确把 new/resume/fork/import 放在 AgentSessionRuntime，且处理 cwd-bound services 重建。
**代价**：需要较大重构和事件订阅重绑定。

### ADR-03：QQ 会话持久化但独立存储

**决定**：不再默认 `SessionManager.inMemory`，使用 QQ 专属 sessionDir。
**理由**：满足远程 new/resume 和宿主重启恢复，同时不混入本地 `/resume`。
**代价**：增加磁盘数据与清理策略。

### ADR-04：文本命令是协议，按钮是增强

**决定**：所有按钮产生或映射到 canonical text command。
**理由**：可测试、可回退、跨客户端、避免被 QQ 能力权限锁死。
**代价**：按钮交互不如纯 callback UI 无痕。

### ADR-05：网关进程级常驻

**决定**：GatewayHost 不随本地 session replacement stop。
**理由**：直接解决重复 `/qqbot-start`。
**代价**：必须处理 reload generation、租约与真正 quit 的清理。

---

## 22. 参考资料

### Pi 官方/项目资料

1. Pi Extensions 文档：
   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
2. Pi SDK 文档：
   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
3. Pi Session Format：
   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
4. Pi SDK session runtime 示例：
   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/13-session-runtime.ts
5. 本机已安装 Pi v0.80.2 文档与 `.d.ts`，用于核对 `AgentSessionRuntime`、`ModelRegistry`、`SessionManager` 和生命周期接口。

### QQ 官方资料

6. QQ 基础消息对话与指令面板/快捷菜单：
   https://bot.q.qq.com/wiki/develop/api-v2/client-func/intro/baseinfo.html
7. QQ 消息按钮：
   https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html
8. QQ Markdown：
   https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html
9. QQ 发送消息与被动回复限制：
   https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html
10. QQ 消息事件与 msg_id 去重说明：
    https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/event.html
11. QQ 事件订阅与通知：
    https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html

### 命令与对话 UX

12. Slack Slash Commands Style Guide（`/command help`、命名和默认帮助）：
    https://medium.com/slack-developer-blog/slash-commands-style-guide-4e91272aa43a
13. Google Chat Commands（可发现命令、短描述、slash/quick command 选择）：
    https://developers.google.com/workspace/chat/commands
14. Discord Application Commands / FAQ（自动完成、验证、错误预防）：
    https://docs.discord.com/developers/interactions/application-commands
    https://support-apps.discord.com/hc/en-us/articles/26501837786775-Slash-Commands-FAQ
15. Telegram Bot Features（命令列表、菜单、按钮、具体命名）：
    https://core.telegram.org/bots/features
16. Microsoft Bot Navigation（全局 help/cancel/start over、立即确认长任务）：
    https://learn.microsoft.com/en-us/azure/bot-service/bot-service-design-navigation
17. Microsoft Error Handling（透明说明错误与恢复动作）：
    https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/cux-handle-errors
18. NN/g Confirmation Dialogs（只确认高风险操作，明确对象和后果）：
    https://www.nngroup.com/articles/confirmation-dialog/

---

## 23. 最终推荐方案摘要

最合适的解决方案不是简单打开 `allowCommands` 或把 `autoStart` 改成 true，而是完成三项结构性升级：

1. **命令控制层**：QQ `/model`、`/new`、`/resume` 等直接调用 Pi SDK；
2. **持久隔离 Runtime**：每个 QQ 对话作用域拥有独立、可恢复的 AgentSessionRuntime；
3. **进程级 GatewayHost**：本地 Pi 会话变化只更换观察器，不关闭 QQ 网关。

在此基础上，用 QQ 原生指令面板、Markdown Keyboard、短列表、明确状态和必要确认，形成适合人类手机使用习惯的操作界面。真正不依赖电脑终端的使用场景，再通过显式 `serve`/OS service 模式补齐。
