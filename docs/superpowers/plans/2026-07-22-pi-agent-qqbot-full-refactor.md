# pi-agent-qqbot 全面重构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将现有 QQ Bot 扩展全面重构为边界清晰、可测试、仅支持原生 macOS/Linux/Windows 的 `pi-agent-qqbot` Pi TypeScript 包，并完成本地类型检查、测试、打包和 Pi 加载验证。

**架构：** 采用 domain、application、infrastructure、presentation、extension 分层。Domain 保存纯规则；application 通过 ports 编排用例；infrastructure 实现 QQ、Pi、配置和媒体适配器；presentation 负责 QQ/TUI 展示；`src/index.ts` 是唯一 composition root。

**技术栈：** Node.js >= 22.19.0、TypeScript 5.9、tsx、Node test runner、Pi extension API、typebox、ws、unpdf。

---

## 已确定的迁移决策

- 不支持 WSL，不做 Windows path 与 `/mnt/<drive>` 的任何互转。
- 只读取 `~/.pi/agent/pi-agent-qqbot.json`；旧配置不在生产代码中探测。
- 本轮不发布、不 push、不重命名远端。README 不编造新 Git URL，package metadata 暂时删除 `repository`、`bugs`、`homepage`。
- 新 session namespace 从空历史开始；旧 `qqbot/sessions` 数据保留在磁盘但不读取、不删除。
- 从旧 host symbol 切换到新 symbol 后必须完整退出并重启 Pi；不支持跨身份热重载。
- `/qqbot-*` 本地命令及 QQ 侧远程命令保留，因为它们描述 QQ Bot 功能而非旧包身份。
- 当前 Windows 基线已知在旧 `outbound-media.test.ts` 的 WSL 路径断言失败；任务 2 必须先恢复绿色基线。

## 最终文件职责

**创建：**

- `src/index.ts`：唯一 Pi extension composition root。
- `src/extension/*`：本地命令、审批 UI、process host 生命周期。
- `src/application/*`：入站、远程命令、Agent turn、回复和 runtime 用例。
- `src/domain/*`：访问规则、对话标识、错误、去重、队列、回复预算。
- `src/infrastructure/config/*`：新配置路径、归一化、串行原子 repository。
- `src/infrastructure/pi/*`：SDK loader、Agent session、conversation registry。
- `src/infrastructure/qq/*`：auth、API、gateway、payload normalization。
- `src/infrastructure/media/*`：入站附件、文档、STT、出站文件。
- `src/infrastructure/platform/*`：原生路径与 opened-file identity。
- `src/presentation/qq/*`：命令解析、键盘、模型分页、回复格式、用户错误。
- `src/presentation/terminal/*`：event reducer、view、widget。
- `test/{characterization,unit,integration,fixtures}`：行为、纯单元与适配器/用例测试。
- `scripts/{check-package,check-identity,smoke-pi-load}.mjs`：包边界、身份和本地 Pi 验证。
- `.github/workflows/ci.yml`：Windows/macOS/Linux 测试定义，不含发布 job。

**删除：** 所有根目录生产 `*.ts`、根目录 `*.test.ts` 和 `pi-qqbot.json.example`，仅在新入口和全部测试绿色后删除。

---

### 任务 1：建立严格、自动发现的 TDD 工具链

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`
- 创建：`tsconfig.json`
- 创建：`test/run-all.ts`
- 移动：根目录六个 `*.test.ts` 到 `test/characterization/`

- [x] **步骤 1：安装本地开发依赖并规范依赖分类**

运行：

```powershell
npm install --save-dev typescript@^5.9.3 tsx@^4.20.6 @types/node@^22.19.0 @types/ws@^8.18.1 @earendil-works/pi-coding-agent@0.80.7 @earendil-works/pi-tui@0.80.7 typebox@1.1.38
```

在 `package.json` 中保留：

```json
{
  "dependencies": {
    "unpdf": "1.6.2",
    "ws": "^8.21.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "engines": { "node": ">=22.19.0" }
}
```

- [x] **步骤 2：创建严格 no-emit TypeScript 配置**

创建 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["*.ts", "src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", ".worktrees"]
}
```

- [x] **步骤 3：编写自动发现测试入口的失败自检**

先创建嵌套 fixture `test/fixtures/discovery/nested.test.ts`，内容：

```ts
import test from "node:test";
import assert from "node:assert/strict";

test("nested discovery fixture", () => assert.equal(process.env.RUN_DISCOVERY_FIXTURE, "1"));
```

运行：

```powershell
node --import tsx test/run-all.ts test/fixtures/discovery
```

预期：FAIL，因为 `test/run-all.ts` 尚不存在。

- [x] **步骤 4：实现跨平台、稳定排序的测试入口**

`test/run-all.ts` 核心实现：

```ts
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function collect(path: string): string[] {
  const absolute = resolve(path);
  if (statSync(absolute).isFile()) return absolute.endsWith(".test.ts") ? [absolute] : [];
  return readdirSync(absolute)
    .flatMap((entry) => collect(resolve(absolute, entry)))
    .sort();
}

const roots = process.argv.slice(2);
const includeDiscoveryFixture = process.env.RUN_DISCOVERY_FIXTURE === "1";
const files = (roots.length ? roots : ["test"])
  .flatMap(collect)
  .filter((path) => includeDiscoveryFixture || (!path.includes("fixtures\\discovery") && !path.includes("fixtures/discovery")));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

用 PowerShell 执行 `$env:RUN_DISCOVERY_FIXTURE = "1"; node --import tsx test/run-all.ts test/fixtures/discovery`，预期 PASS；随后清除环境变量并删除该临时 fixture。

- [x] **步骤 5：迁移现有测试并改用 `node:test`**

每个测试改为以下结构，不改变现有断言内容：

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "../../config.ts";

test("normalizes existing config behavior", () => {
  assert.equal(normalizeConfig({}).enabled, false);
});
```

暂时保留 Windows/WSL 失败断言，任务 2 再以明确原生契约替换。

- [x] **步骤 6：更新 npm scripts 并验证工具链**

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx test/run-all.ts",
    "test:focused": "node --import tsx test/run-all.ts",
    "verify": "npm run typecheck && npm test",
    "prepack": "npm run verify"
  }
}
```

运行：

```powershell
npm run typecheck
npm test
```

预期：typecheck 先暴露真实源码问题；test 只保留已知 Windows 路径失败。

- [x] **步骤 7：仅修复类型基线，不改变行为**

为旧根源码补充必要的参数类型、undefined narrowing 和 Node timer 类型，直到 `npm run typecheck` PASS。不得在此步骤重构流程或改变用户文案；任何行为变化留给后续带失败测试的任务。

- [x] **步骤 8：提交工具链**

```powershell
git add package.json package-lock.json tsconfig.json test

git commit -m "test: establish strict cross-platform TDD baseline"
```

---

### 任务 2：删除 WSL 契约并建立原生平台文件安全

**文件：**
- 创建：`src/infrastructure/platform/local-paths.ts`
- 创建：`src/infrastructure/platform/opened-file-identity.ts`
- 创建：`test/unit/platform/local-paths.test.ts`
- 创建：`test/integration/platform/opened-file-identity.test.ts`
- 修改：`test/characterization/outbound-media.test.ts`

- [x] **步骤 1：编写原生路径失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { win32, posix } from "node:path";

import { normalizeLocalPath } from "../../../src/infrastructure/platform/local-paths.ts";

test("keeps native Windows drive paths", () => {
  assert.equal(normalizeLocalPath("C:\\Users\\tester\\a.png", "C:\\work", win32), "C:\\Users\\tester\\a.png");
});

test("resolves native POSIX paths without WSL mapping", () => {
  assert.equal(normalizeLocalPath("/tmp/a.png", "/work", posix), "/tmp/a.png");
  assert.equal(normalizeLocalPath("C:\\tmp\\a.png", "/work", posix), "/work/C:\\tmp\\a.png");
});
```

运行：

```powershell
npm run test:focused -- test/unit/platform/local-paths.test.ts
```

预期：FAIL，模块不存在。

- [x] **步骤 2：实现纯路径解析与 containment helper**

```ts
import type path from "node:path";

export type PathApi = Pick<typeof path, "isAbsolute" | "relative" | "resolve" | "sep">;

export function normalizeLocalPath(input: string, cwd: string, pathApi: PathApi): string {
  const value = input.trim().replace(/^@(?=.)/, "");
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("path_invalid");
  return pathApi.resolve(pathApi.isAbsolute(value) ? value : pathApi.resolve(cwd, value));
}

export function isWithinRoot(candidate: string, root: string, pathApi: PathApi): boolean {
  const relative = pathApi.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}
```

- [x] **步骤 3：编写 opened-file identity 与 race 失败测试**

覆盖：普通文件、目录、空文件、hard link、root 外 symlink/junction、打开后 rename replacement、abort、重复 close。平台专属 capability 不满足时使用带原因的 `test.skip()`。

运行：

```powershell
npm run test:focused -- test/integration/platform/opened-file-identity.test.ts
```

预期：FAIL，模块不存在。

- [x] **步骤 4：实现按平台明确降级的 opened file API**

```ts
export interface OpenedLocalFile {
  path: string;
  size: number;
  read(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface OpenLocalFileOptions {
  candidate: string;
  deniedRoots: readonly string[];
  signal?: AbortSignal;
  beforeReadForTest?: () => Promise<void>;
}
```

实现要求：schema 4 使用默认允许的路径黑名单；先 `realpath` 并拒绝命中 `deniedRoots` 的候选路径；以 `O_RDONLY | O_NOFOLLOW(若可用)` 打开；handle stat 必须为普通文件且 `nlink <= 1`；Linux 可比较 `/proc/self/fd/<fd>`；其他平台比较打开前 path stat、handle stat 和读取后 handle stat；所有路径 finally 关闭 handle。

- [x] **步骤 5：替换旧 WSL characterization assertion 并恢复绿线**

删除 `/mnt/c` 期望，改为根据 `process.platform` 验证当前宿主原生路径；源码测试中增加断言不生成 `/mnt/`。

运行：

```powershell
npm run test:focused -- test/unit/platform
npm run test:focused -- test/integration/platform
npm test
npm run typecheck
```

预期：PASS。

- [x] **步骤 6：提交平台层**

```powershell
git add src/infrastructure/platform test/unit/platform test/integration/platform test/characterization/outbound-media.test.ts
git commit -m "refactor(platform): enforce native path and file identity contracts"
```

---

### 任务 3：提取纯 Domain 与唯一回复预算

**文件：**
- 创建：`src/domain/{access,conversation,errors,message-dedupe,message-queue,reply-budget}.ts`
- 创建：`test/unit/domain/*.test.ts`
- 创建：`test/unit/architecture/import-boundaries.test.ts`

- [x] **步骤 1：先写 access、dedupe、queue 失败测试**

测试必须覆盖 allow user/group、管理员、pending request TTL/cooldown、授权前不保存正文；dedupe TTL/最大容量；FIFO/full/remove conversation。

运行：

```powershell
npm run test:focused -- test/unit/domain
```

预期：FAIL，domain 模块不存在。

- [x] **步骤 2：实现最小 domain API**

```ts
export interface Clock { now(): number; }
export interface ConversationId { type: "private" | "group"; value: string; }
export class DomainError extends Error {
  constructor(readonly code: string, readonly safeMessage: string, readonly cause?: unknown) { super(safeMessage); }
}
```

`BoundedMessageQueue` 只管理 FIFO；`MessageDedupe.admit(id)` 只管理 TTL 和容量；不导入 QQ、Pi、fs 或 presentation。

- [x] **步骤 3：先写 ReplyBudget 状态表失败测试**

```ts
const budget = new ReplyBudget(4);
assert.equal(budget.reserve("progress"), 1);
assert.equal(budget.reserve("media"), 2);
assert.equal(budget.reserve("final"), 3);
assert.equal(budget.remaining, 1);
```

覆盖 progress+final、busy+final、media 保留 final、Markdown rejected 后 plain 使用新 seq、耗尽返回 undefined、同类 ack 不重复。

- [x] **步骤 4：实现 ReplyBudget 为 msg_seq 唯一所有者**

```ts
export type ReplyPurpose = "progress" | "busy" | "media" | "markdown" | "plain" | "final";

export class ReplyBudget {
  #next = 1;
  #reserved = new Set<ReplyPurpose>();
  constructor(private readonly limit: number) {}
  reserve(purpose: ReplyPurpose, options: { once?: boolean; keepFinal?: boolean } = {}): number | undefined {
    if (options.once && this.#reserved.has(purpose)) return undefined;
    if (options.keepFinal && this.#next >= this.limit) return undefined;
    if (this.#next > this.limit) return undefined;
    this.#reserved.add(purpose);
    return this.#next++;
  }
  get remaining(): number { return Math.max(0, this.limit - this.#next + 1); }
}
```

- [x] **步骤 5：添加依赖方向测试**

扫描 `src/**/*.ts` 的相对 import，断言 `domain` 不导入其他层，`application` 不导入具体 `infrastructure` 或 `presentation`。

- [x] **步骤 6：验证并提交**

```powershell
npm run test:focused -- test/unit/domain
npm run test:focused -- test/unit/architecture/import-boundaries.test.ts
npm run typecheck
git add src/domain test/unit/domain test/unit/architecture
git commit -m "refactor(domain): extract access queue dedupe and reply budget"
```

---

### 任务 4：重建新配置 Repository

**文件：**
- 创建：`src/infrastructure/config/{paths,normalize-config,config-repository}.ts`
- 创建：`test/unit/config/*.test.ts`
- 创建：`test/integration/config/config-repository.test.ts`
- 创建：`pi-agent-qqbot.json.example`

- [x] **步骤 1：写新配置路径与无兼容失败测试**

```ts
assert.equal(configPath("C:\\Users\\me"), "C:\\Users\\me\\.pi\\agent\\pi-agent-qqbot.json");
```

并在临时 home 中只创建 `pi-qqbot.json`，断言 repository 返回 `missing: true`。

- [x] **步骤 2：迁移并测试 schema 3 normalization**

把当前默认值和 clamp 行为转入 `normalize-config.ts`。测试现有全部 config assertions；删除旧 `autoStart`/`allowCommands` 作为现行输入兼容。

- [x] **步骤 3：写错误分类与并发更新失败测试**

覆盖 `ENOENT`、`EACCES/EPERM`、目录占位、坏 JSON；并发 100 次 approve/revoke 后结果不得丢更新，失败后不得残留 `.tmp-*`。

- [x] **步骤 4：实现串行、原子、保留未知字段的 repository**

```ts
export class FileConfigRepository {
  #writes: Promise<unknown> = Promise.resolve();
  mutate(mutator: (raw: Record<string, unknown>) => Record<string, unknown>): Promise<PiAgentQQBotConfig> {
    const operation = this.#writes.then(() => this.#mutate(mutator));
    this.#writes = operation.catch(() => undefined);
    return operation;
  }
}
```

`#mutate` 必须在队列内重新读取，使用 `randomUUID()`、`open("wx", 0o600)`、write、sync、close、rename、chmod；finally 删除唯一 temp；只把 `ENOENT` 当 missing。

- [ ] **步骤 5：验证与提交**

```powershell
npm run test:focused -- test/unit/config
npm run test:focused -- test/integration/config/config-repository.test.ts
npm run typecheck
git add src/infrastructure/config test/unit/config test/integration/config pi-agent-qqbot.json.example
git commit -m "refactor(config): serialize secure pi-agent-qqbot config writes"
```

---

### 任务 5：定义 Application Ports 并迁移 QQ Presentation

**文件：**
- 创建：`src/application/ports.ts`
- 创建：`src/presentation/qq/{command-parser,keyboard,model-pages,reply-formatter,user-facing-errors}.ts`
- 创建：`test/unit/presentation/*.test.ts`
- 创建：`test/characterization/{command-behavior,reply-formatting,local-command-registration}.test.ts`

- [x] **步骤 1：写完整命令和展示 characterization tests**

锁定 QQ 侧 `/help|status|last|model|thinking|new|sessions|resume|name|compact|stop`，兼容别名 `/qqbot-help|status|last`，以及本地 `/qqbot-start|stop|status|runtime|reconnect|last|requests|approve|deny|revoke`。

- [x] **步骤 2：定义 ports，不引用具体适配器**

```ts
export interface QQGatewayPort { start(): Promise<void>; stop(): Promise<void>; }
export interface QQReplyPort { sendText(target: QQReplyTarget, text: string, seq: number): Promise<void>; }
export interface AgentSessionPort { run(input: AgentTurnInput): Promise<AgentTurnResult>; abort(): Promise<void>; dispose(): Promise<void>; }
export interface ConfigRepositoryPort { load(): Promise<LoadConfigResult>; mutateAccess(change: AccessChange): Promise<PiAgentQQBotConfig>; }
export interface RuntimeObserver { onEvent(event: RuntimeEvent): void; }
```

类型放到 owning module 或 `ports.ts`，不创建新的全域 `types.ts`。

- [x] **步骤 3：先把旧 assertions 指向新 presentation 模块，确认失败**

运行：

```powershell
npm run test:focused -- test/unit/presentation
```

预期：FAIL，新模块尚未实现。

- [x] **步骤 4：迁移纯 parser、keyboard、pagination、formatter、safe error**

错误映射必须过滤 secret/token、URL query、stack 和完整本地路径。Presentation 不构造 QQ/Pi/fs 客户端。

- [ ] **步骤 5：验证与提交**

```powershell
npm run test:focused -- test/unit/presentation
npm run test:focused -- test/characterization
npm run typecheck
git add src/application/ports.ts src/presentation/qq test/unit/presentation test/characterization
git commit -m "refactor(presentation): define ports and isolate QQ formatting"
```

---

### 任务 6：迁移 QQ Auth、API、Gateway 与 Payload Normalizer

**文件：**
- 创建：`src/infrastructure/qq/{auth,api,gateway,payload-normalizer}.ts`
- 创建：`test/unit/qq/payload-normalizer.test.ts`
- 创建：`test/integration/qq/{auth,api,gateway}.test.ts`

- [ ] **步骤 1：写 auth single-flight 与 payload 失败测试**

Fake fetch 覆盖 token cache、并发 refresh、401、secret redaction；payload 覆盖 C2C/group、附件和 protocol-relative URL。

- [ ] **步骤 2：迁移 Auth 与 API**

构造函数注入 fetch/clock。保留 QQ text/Markdown/keyboard/media payload 和 `QQApiError.requestAccepted`，发送 API 不做隐式 retry。

- [ ] **步骤 3：写 Gateway fake-timer 失败测试**

覆盖 Hello->Identify、heartbeat seq、READY、Resume、invalid session、server reconnect、close/backoff 1/2/4/.../30 秒、五次停止、manual reset。

- [ ] **步骤 4：实现可注入 Gateway**

```ts
export interface WebSocketFactory { connect(url: string): WebSocketLike; }
export interface TimerPort { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void; }
```

Gateway retry 只能重连 transport，不重放 application message。

- [ ] **步骤 5：验证与提交**

```powershell
npm run test:focused -- test/unit/qq
npm run test:focused -- test/integration/qq
npm run typecheck
git add src/infrastructure/qq test/unit/qq test/integration/qq
git commit -m "refactor(qq): isolate auth api gateway and payload normalization"
```

---

### 任务 7：迁移 Pi SDK、隔离 Agent Session 与 Conversation Registry

**文件：**
- 创建：`src/infrastructure/pi/{sdk-loader,agent-session,conversation-registry}.ts`
- 创建：`test/unit/pi/sdk-loader.test.ts`
- 创建：`test/integration/pi/{agent-session,conversation-registry}.test.ts`
- 创建：`test/fixtures/pi-sdk.ts`

- [x] **步骤 1：写 SDK resolution 失败测试**

覆盖显式 URL/path、`import.meta.resolve`、launcher fallback、候选不存在、路径含空格；把 `process.argv[1]` 设为不含 Pi 包名仍应成功。

- [x] **步骤 2：实现验证后的 SDK loader**

```ts
export interface SdkResolverOptions {
  explicit?: URL;
  resolveModule(specifier: string): Promise<string>;
  launcher?: string;
}
```

每个候选必须 realpath/stat 为文件才 import；错误只报告来源类别，不泄露敏感完整路径。

- [ ] **步骤 3：写 Agent Session 与 Registry 失败测试**

覆盖 create runtime、model/thinking/new/list/resume/name/compact、abort/dispose、事件转换、outbound tool、初始化失败清理、同 conversation 只初始化一次、跨 conversation 隔离、LRU/idle disposal。

- [x] **步骤 4：迁移实现并采用新 namespace**

存储路径固定为 `<agentDir>/pi-agent-qqbot/sessions/<hash>`，hash salt 为 `pi-agent-qqbot\0${conversationKey}`；不读取或删除旧目录。扩展递归排除使用当前 package root 的 realpath，不匹配旧包路径字符串。

- [ ] **步骤 5：验证与提交**

```powershell
npm run test:focused -- test/unit/pi/sdk-loader.test.ts
npm run test:focused -- test/integration/pi
npm run typecheck
git add src/infrastructure/pi test/unit/pi test/integration/pi test/fixtures/pi-sdk.ts
git commit -m "refactor(pi): add resilient SDK loading and isolated sessions"
```

---

### 任务 8：迁移入站与出站 Media

**文件：**
- 创建：`src/infrastructure/media/{attachment-downloader,attachment-pipeline,document-extractors,outbound-media,stt}.ts`
- 创建：`test/unit/media/*.test.ts`
- 创建：`test/integration/media/*.test.ts`

- [ ] **步骤 1：写 downloader/pipeline 安全失败测试**

本地 fake HTTPS server 覆盖 redirect revalidation、private IP、DNS pinning、content-length/stream overflow、timeout、retry、abort、workspace cleanup、media sniff、TXT/PDF limits、DOC rejection、QQ ASR/STT fallback。

- [x] **步骤 2：迁移入站媒体实现**

临时目录改为 `<tmp>/pi-agent-qqbot/<runtime>/<message>`；User-Agent 由集中 product identity 提供；所有 success/failure/abort 路径删除 workspace。

- [x] **步骤 3：写 outbound 失败测试**

覆盖 allow-root、root 内/外 symlink、Windows junction、rename race、hard link、non-file、empty/oversize、PNG/JPEG sniff、unknown send result、observer throw、close/abort。

- [x] **步骤 4：接入 platform API 与 ReplyBudget**

```ts
export class OutboundMediaDelivery {
  constructor(
    private readonly files: LocalFilePort,
    private readonly replies: QQMediaReplyPort,
    private readonly budget: ReplyBudget,
  ) {}
}
```

模型只能提供 path；QQ target 和 reply metadata 必须由当前 turn 绑定；adapter 不拥有 `nextMsgSeq`。

- [ ] **步骤 5：验证与提交**

```powershell
npm run test:focused -- test/unit/media
npm run test:focused -- test/integration/media
npm run typecheck
git add src/infrastructure/media test/unit/media test/integration/media
git commit -m "refactor(media): enforce bounded native-platform delivery"
```

---

### 任务 9：实现 Application 用例并替换 Monolithic Runtime

**文件：**
- 创建：`src/application/{process-inbound-message,execute-remote-command,run-agent-turn,deliver-reply,bot-runtime}.ts`
- 创建：`test/integration/application/*.test.ts`
- 创建：`test/fixtures/ports.ts`

- [ ] **步骤 1：编写 scripted fake ports**

```ts
export class FakeReplyPort implements QQReplyPort {
  readonly sent: Array<{ text: string; seq: number }> = [];
  async sendText(_target: QQReplyTarget, text: string, seq: number): Promise<void> { this.sent.push({ text, seq }); }
}
```

其他 fake 覆盖 gateway、session、attachments、config、observer 和 clock。

- [ ] **步骤 2：写入站与远程命令失败测试**

覆盖 allow/deny、access request、不保留未授权正文、dedupe、command/prompt 分流、纯附件入队、queue full、全局 FIFO、按 conversation `/stop` 以及任务 5 的所有命令语义。

- [x] **步骤 3：实现 `processInboundMessage` 与 `executeRemoteCommand`**

函数通过 ports 接收依赖，不构造具体 adapter。授权检查必须早于附件下载和 prompt 保存；去重只针对已授权/可处理消息。

- [x] **步骤 4：写 Agent turn cleanup 失败测试**

覆盖成功、Agent error、empty result、vision refusal、abort、attachment cleanup、outbound close、observer throw、cleanup error 不覆盖 primary error。

- [x] **步骤 5：实现 `runAgentTurn` 的确定性 finally**

```ts
try {
  prepared = await attachments.prepare(message);
  return await session.run(prepared.input);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  await outbound.close().catch((error) => logger.cleanup(error, primaryError));
  await prepared?.cleanup().catch((error) => logger.cleanup(error, primaryError));
}
```

- [x] **步骤 6：写并实现统一 `deliverReply`**

测试 progress+media+Markdown rejected+plain+final 的序号表。所有发送从同一 `ReplyBudget` reserve；Markdown fallback 必须使用新 seq。

- [ ] **步骤 7：实现薄 `BotRuntime`**

`bot-runtime.ts` 只管理 ports、pump、active abort、status summary 和 observer；不得包含 parser、transport、文件或 widget 具体逻辑。

- [ ] **步骤 8：验证与提交**

```powershell
npm run test:focused -- test/integration/application
npm run typecheck
npm test
git add src/application test/integration/application test/fixtures/ports.ts
git commit -m "refactor(application): compose inbound commands turns and replies"
```

---

### 任务 10：拆分 Terminal 展示并重建 Extension Lifecycle

**文件：**
- 创建：`src/presentation/terminal/{event-reducer,conversation-view,widget}.ts`
- 创建：`src/extension/{access-approval-ui,register-local-commands,lifecycle}.ts`
- 创建：`test/unit/terminal/*.test.ts`
- 创建：`test/integration/extension/*.test.ts`

- [x] **步骤 1：写 reducer 与 widget 失败测试**

Reducer 纯函数覆盖 runtime status、message/tool/media line、bounded history、dispose；widget 在固定 width 下输出稳定，不包含状态变更逻辑。

- [x] **步骤 2：迁移 terminal presentation**

`event-reducer.ts` 不导入 Pi TUI；`widget.ts` 是唯一直接依赖 `@earendil-works/pi-tui` 的 terminal 文件。

- [x] **步骤 3：写本地命令注册与审批失败测试**

Fake ExtensionAPI/Context 覆盖 TUI/非 TUI、所有 `/qqbot-*` 命令、approve/revoke persist-first、取消确认、错误通知脱敏。

- [x] **步骤 4：实现本地命令与审批 UI**

命令 handler 只调用 application/lifecycle API；不在 `src/index.ts` 内创建长闭包。

- [ ] **步骤 5：写 host lifecycle race 失败测试**

覆盖 auto/manual/disabled/invalid config、start single-flight、stop-during-start、start failure cleanup/retry、owner attach/detach、replacement/drain、stale UI context、重复 stop/shutdown。

- [x] **步骤 6：实现新 host symbol 生命周期**

使用 `Symbol.for("pi-agent-qqbot.host.v1")`。Build ID 必须覆盖整个 `src/` 或由 package version + source fingerprint 明确注入，不能只扫描当前目录。旧 symbol 不接管；切换时要求冷重启。

- [ ] **步骤 7：验证与提交**

```powershell
npm run test:focused -- test/unit/terminal
npm run test:focused -- test/integration/extension
npm run typecheck
npm test
git add src/presentation/terminal src/extension test/unit/terminal test/integration/extension
git commit -m "refactor(extension): rebuild commands terminal view and host lifecycle"
```

---

### 任务 11：切换唯一入口并删除旧平铺实现

**文件：**
- 创建：`src/index.ts`
- 创建：`test/integration/extension/composition-root.test.ts`
- 删除：根目录全部生产 `*.ts`、根目录旧 `*.test.ts`

- [x] **步骤 1：写 composition root 失败测试**

以 fake factories 加载 default export，断言命令与 lifecycle events 注册，且 factory 阶段不启动 socket/timer/watcher。

- [x] **步骤 2：实现唯一 composition root**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtensionServices } from "./extension/lifecycle.ts";
import { registerLocalCommands } from "./extension/register-local-commands.ts";

export default function piAgentQQBot(pi: ExtensionAPI): void {
  const services = createExtensionServices(pi);
  registerLocalCommands(pi, services);
  services.registerLifecycle();
}
```

- [x] **步骤 3：运行新入口完整测试后删除旧模块**

将 `tsconfig.json` 的 `include` 收紧为 `["src/**/*.ts", "test/**/*.ts"]`。只有以下命令全部通过才删除：

```powershell
npm run test:focused -- test/integration/extension/composition-root.test.ts
npm run typecheck
npm test
```

删除根目录 `index.ts`、`router.ts`、`types.ts` 及其余旧生产模块和已迁移测试。

- [x] **步骤 4：再次验证依赖方向与完整行为**

```powershell
npm run test:focused -- test/unit/architecture/import-boundaries.test.ts
npm run typecheck
npm test
```

预期：PASS；根 `router.ts` 和 `types.ts` 不存在。

- [x] **步骤 5：提交 cutover**

```powershell
git add -A src test
git commit -m "refactor: cut over to layered pi-agent-qqbot runtime"
```

---

### 任务 12：完成包身份、文档、CI 与 Tarball 边界

**文件：**
- 修改：`package.json`、`package-lock.json`、`.gitignore`、`.npmignore`、`README.md`
- 创建：`scripts/check-package.mjs`、`scripts/check-identity.mjs`、`scripts/smoke-pi-load.mjs`
- 创建：`.github/workflows/ci.yml`
- 移动：四份根目录历史计划到 `docs/plans/legacy/`
- 删除：`pi-qqbot.json.example`

- [x] **步骤 1：先写 identity check 失败脚本**

`scripts/check-identity.mjs` 扫描现行 `src/`、`package.json`、`README.md`、新示例，禁止：`@xsqm/pi-qqbot`、`pi-coding-agent-qqbot`、`pi-qqbot.json`、`/mnt/c`、旧日志/User-Agent 身份。允许 `docs/plans/legacy` 和已批准规格中的历史描述。

运行：

```powershell
node scripts/check-identity.mjs
```

预期：FAIL，身份尚未完全切换。

- [x] **步骤 2：更新 package metadata 与 files allowlist**

```json
{
  "name": "pi-agent-qqbot",
  "files": ["src", "pi-agent-qqbot.json.example", "README.md", "LICENSE"],
  "pi": { "extensions": ["./src/index.ts"] }
}
```

删除 `publishConfig`、`repository`、`bugs`、`homepage`；不增加 `main`、`exports` 或 `dist`。

- [x] **步骤 3：统一代码与 ignore 身份**

更新日志、temp dir、host symbol、widget/status keys、session namespace、recursion exclusion、User-Agent。`.gitignore` 同时忽略真实 `pi-agent-qqbot.json`、旧真实配置、`.pi-subagents/`、tgz/env；`.npmignore` 作为 defense in depth。

- [x] **步骤 4：重写当前 README**

中英文都包含：`pi-agent-qqbot` 名称、新配置文件、bash/zsh 与 PowerShell、本地 path 安装、原生 macOS/Linux/Windows、明确不支持 WSL、安全边界。npm 安装明确标注“尚未发布”；不提供 Git clone URL，不引用旧远端。

- [x] **步骤 5：声明最终验证 scripts 并实现 package tarball 检查**

在 `package.json` 增加：

```json
{
  "scripts": {
    "identity:check": "node scripts/check-identity.mjs",
    "pack:check": "npm pack --dry-run --json --ignore-scripts",
    "test:package": "node scripts/check-package.mjs",
    "smoke:pi": "node scripts/smoke-pi-load.mjs"
  }
}
```

`scripts/check-package.mjs` 使用临时目录运行 `npm pack --json --ignore-scripts`，读取结果的 `files[].path` 相对路径并断言：

```js
const required = ["src/index.ts", "README.md", "LICENSE", "pi-agent-qqbot.json.example"];
const forbidden = [/\.test\.ts$/, /^test\//, /^docs\//, /pi-agent-qqbot\.json$/, /\.env/, /\.git/, /\.pi-subagents/];
```

再在临时 consumer 安装 tgz，验证 `npm ls --omit=dev` 和 peer metadata；finally 删除临时目录。

- [x] **步骤 6：实现隔离 Pi RPC smoke**

`scripts/smoke-pi-load.mjs` 设置临时 `PI_CODING_AGENT_DIR`，启动 `pi --mode rpc --no-session --no-extensions -e ./src/index.ts`，发送 `get_commands`，断言本地 qqbot commands 注册并干净退出；不得连接 QQ。

- [x] **步骤 7：创建三平台 CI 定义**

```yaml
strategy:
  matrix:
    os: [windows-latest, ubuntu-latest, macos-latest]
    node: [22.19.0, 24]
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: "${{ matrix.node }}", cache: npm }
  - run: npm ci
  - run: npm run typecheck
  - run: npm test
  - run: npm run test:package
```

不得添加 publish job。

- [x] **步骤 8：归档历史计划并验证身份/包**

```powershell
npm run identity:check
npm run typecheck
npm test
npm run pack:check
npm run test:package
npm run smoke:pi -- .
```

预期：全部 PASS。

- [x] **步骤 9：提交包与文档**

```powershell
git add package.json package-lock.json .gitignore .npmignore README.md scripts .github docs/plans pi-agent-qqbot.json.example
git add -u
git commit -m "chore: rename package and lock package contents"
```

---

### 任务 13：受保护地重命名真实配置并执行本地 Pi Smoke

**文件：**
- 外部状态：`~/.pi/agent/pi-qqbot.json` -> `~/.pi/agent/pi-agent-qqbot.json`
- 不修改项目源码

- [x] **步骤 1：先运行全部自动 gate**

```powershell
npm install
npm run typecheck
npm test
npm run identity:check
npm run pack:check
npm run test:package
npm run smoke:pi -- .
```

预期：全部 PASS。任何失败都禁止进入真实配置步骤。

- [ ] **步骤 2：完整退出加载旧代码的 Pi 进程**

确认旧 host 不再驻留。不要用 `/reload` 跨旧/新 symbol 测试。

- [x] **步骤 3：只检查存在性并安全移动配置**

```powershell
$old = Join-Path $HOME ".pi\agent\pi-qqbot.json"
$new = Join-Path $HOME ".pi\agent\pi-agent-qqbot.json"
if ((Test-Path -LiteralPath $old) -and (Test-Path -LiteralPath $new)) {
  throw "Both old and new QQ bot configs exist; refusing to overwrite."
}
if (Test-Path -LiteralPath $old) {
  Move-Item -LiteralPath $old -Destination $new
}
```

禁止 `Get-Content`、回显配置或覆盖/删除任一文件。

- [ ] **步骤 4：用新进程执行真实本地 smoke**

验证扩展发现、新配置路径加载、`/qqbot-status`、`/qqbot-start`、`/qqbot-stop`。真实 QQ 私聊只有凭据、网络和操作者条件允许时执行；报告是否实际执行，不显示凭据。

- [ ] **步骤 5：记录验证结果，不提交 home 配置**

```powershell
git status --short
git diff --check
```

只提交必要的测试/脚本修正；真实配置永不进入 Git。

---

### 任务 14：最终规格映射、审查与完成审计

**文件：**
- 审查：全部 diff
- 重点：`src/index.ts`、`src/application/**`、`src/domain/**`、`src/infrastructure/config/**`、`src/infrastructure/platform/**`、`src/infrastructure/media/outbound-media.ts`、`package.json`、`README.md`

- [x] **步骤 1：逐条映射设计完成标准到证据**

形成表格：需求、文件证据、测试命令、结果、残余风险。macOS/Linux CI 未实际运行时明确写“仅定义，未验证”。

- [ ] **步骤 2：运行诊断与完整 gate**

```powershell
npm run typecheck
npm test
npm run identity:check
npm run pack:check
npm run test:package
npm run smoke:pi -- .
git diff --check
git status --short
```

同时运行 `lens_diagnostics mode=all`；有 blocking error 不得完成。

- [x] **步骤 3：执行独立代码审查**

检查依赖方向、error redaction、finally cleanup、ReplyBudget 单一所有权、无 WSL mapping、无现行旧身份、无真实配置/凭据、无 publish/remote mutation。

- [x] **步骤 4：只修复审查发现并重跑相关 gate**

每个 blocker/high finding 独立修复，使用所属任务的 focused test，再运行完整 gate。不得添加新产品功能。

- [ ] **步骤 5：确认提交边界与工作树状态**

```powershell
git log --oneline --decorate -20
git status --short --branch
```

预期：实现提交清晰，源码无未提交修改；只允许明确记录的本地非项目产物。

---

## 停止与升级条件

出现以下任一情况立即停止，不猜测、不覆盖：

- 新旧真实配置同时存在，或移动需要覆盖/删除文件。
- Windows native path/file race 无法达到设计保证。
- Characterization tests 显示需要改变现有 QQ 用户能力，但没有新授权。
- Pi SDK `0.80.7` 与声明支持版本没有可适配的共同 API。
- Tarball 包含测试、真实配置、env、plans、git、subagent artifact，或缺 runtime dependency。
- 日志、fixture、artifact 出现 client secret、access token、完整敏感路径或真实 OpenID。
- 新远端 URL 仍不存在却有人要求 README/package 声称 Git 安装地址。
- 任一完整 gate 失败，或任务要求 publish、deprecate、push、远端重命名。

## 禁止命令

本计划期间不得运行：

```text
npm publish
npm deprecate
git push
任何 GitHub 仓库重命名/创建命令
```
