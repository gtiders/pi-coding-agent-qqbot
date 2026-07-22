import { executeRemoteCommand } from "../application/execute-remote-command";
import type { ConnectionState, PiAgentQQBotConfig, QQInboundMessage, QQKeyboard } from "../application/ports";
import type { QQAgentSession, QQModelInfo, QQSessionInfo } from "../infrastructure/pi/agent-session";
import { normalizeCommandText, parseQQCommand, type ParsedQQCommand } from "../presentation/qq/command-parser";
import { buildCommandKeyboard, type QQCommandButton } from "../presentation/qq/keyboard";
import { buildModelPage, formatModelPageFallback, type ModelPage } from "../presentation/qq/model-pages";
import { humanizeSessionPreview } from "../presentation/qq/user-facing-errors";
import { authorizeQQCommand, QQ_COMMAND_NAMES, QQ_REMOTE_BLOCKED_COMMANDS } from "./execute-remote-command";

export interface RemoteCommandControllerDependencies {
	config(): PiAgentQQBotConfig;
	connectionState(): ConnectionState;
	queueSize(): number;
	getConversation(message: QQInboundMessage): Promise<QQAgentSession>;
	hasActiveOrQueuedConversation(message: QQInboundMessage): boolean;
	stopConversation(message: QQInboundMessage): Promise<{ removed: number; wasRunning: boolean }>;
	reply(message: QQInboundMessage, text: string, keyboard?: QQKeyboard): Promise<void>;
	lastSummary(): string;
	onError(message: QQInboundMessage, commandName: string, detail: string): void;
}

/** Adapts QQ presentation and Pi sessions to the pure remote-command dispatcher. */
export class RemoteCommandController {
	constructor(private readonly dependencies: RemoteCommandControllerDependencies) {}

	async handle(message: QQInboundMessage, text: string): Promise<void> {
		let command: ParsedQQCommand | undefined;
		try {
			command = parseQQCommand(normalizeCommandText(text));
		} catch (error) {
			await this.dependencies.reply(
				message,
				`## 命令未执行\n\n${error instanceof Error ? error.message : String(error)}\n\n发送 \`/help\` 查看用法。`,
			);
			return;
		}
		if (!command) return;
		const authorization = authorizeQQCommand(this.dependencies.config(), message, command);
		if (!authorization.allowed) {
			const known = QQ_COMMAND_NAMES.has(command.name);
			const blocked = QQ_REMOTE_BLOCKED_COMMANDS.has(command.name);
			const title = known && !blocked ? "命令未开启或无权限" : "命令未执行";
			await this.dependencies.reply(message, `## ${title}\n\n${authorization.reason}\n\n发送 \`/help\` 查看可用命令。`);
			return;
		}
		try {
			await executeRemoteCommand(command, {
				help: () => this.dependencies.reply(message, this.commandHelp(command.args[0]), this.helpKeyboard(message)),
				status: async () => this.dependencies.reply(message, await this.statusText(message), this.helpKeyboard(message)),
				last: () => this.dependencies.reply(message, this.dependencies.lastSummary()),
				model: () => this.handleModel(message, command.rawArgs),
				thinking: () => this.handleThinking(message, command.args[0]),
				new: () => this.handleNew(message, command.rawArgs),
				sessions: () => this.handleSessions(message, command.rawArgs),
				resume: () => this.handleResume(message, command.args[0]),
				name: () => this.handleName(message, command.rawArgs),
				compact: () => this.handleCompact(message, command.rawArgs),
				stop: () => this.handleStop(message),
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.dependencies.onError(message, command.name, detail);
			await this.dependencies.reply(
				message,
				`## 命令未执行\n\n${sanitizeCommandError(detail)}\n\n当前 QQ 会话仍保持原状态。发送 \`/help ${command.name}\` 查看用法。`,
			);
		}
	}

	keyboard(message: QQInboundMessage, rows: QQCommandButton[][]): QQKeyboard | undefined {
		return this.dependencies.config().commands.buttons ? buildCommandKeyboard(message, rows) : undefined;
	}

	private async handleModel(message: QQInboundMessage, query: string): Promise<void> {
		const session = await this.dependencies.getConversation(message);
		const current = session.currentModel();
		const allModels = rankModels(session.availableModels(), "");
		const tokens = query.trim().split(/\s+/).filter(Boolean);
		let page = 1;
		if (tokens.length >= 2 && /^page$/i.test(tokens.at(-2) ?? "") && /^\d+$/.test(tokens.at(-1) ?? "")) {
			page = Math.max(1, Number(tokens.at(-1)));
			tokens.splice(-2, 2);
		}
		const queryText = tokens.join(" ").trim();
		let normalizedQuery = queryText.toLowerCase();
		if (!normalizedQuery) {
			const modelPage = buildModelPage(allModels, page, this.dependencies.config().commands.modelPageSize);
			const lines = [
				"## 当前 QQ 模型",
				"",
				current ? `**${current.provider}/${current.id}**` : "当前没有可用模型",
				current ? `- 输入：${current.input.join("、")}` : "",
				`- 思考等级：${session.thinkingLevel()}`,
				"",
				`## 可用模型（${modelPage.page}/${modelPage.totalPages}，共 ${modelPage.total} 个）`,
				"",
				...modelPage.models.map((model, index) => `${modelPage.offset + index + 1}. \`${model.provider}/${model.id}\`${model.input.includes("image") ? " · 图片" : ""}${model.reasoning ? " · 推理" : ""}`),
				"",
				formatModelPageFallback(modelPage),
			].filter(Boolean);
			await this.dependencies.reply(message, lines.join("\n"), this.modelKeyboard(message, modelPage));
			return;
		}
		if (/^\d+$/.test(normalizedQuery)) {
			const index = Number(normalizedQuery) - 1;
			if (!allModels[index]) throw new Error("模型序号无效或列表已变化；请重新发送 /model");
			normalizedQuery = `${allModels[index].provider}/${allModels[index].id}`.toLowerCase();
		}
		const models = rankModels(session.availableModels(), normalizedQuery);
		const exact = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedQuery);
		const matches = exact ? [exact] : models.filter((model) => modelMatches(model, normalizedQuery));
		if (!matches.length) throw new Error(`没有找到已配置认证且匹配“${query.trim()}”的模型`);
		if (matches.length > 1) {
			const matchPage = buildModelPage(matches, page, this.dependencies.config().commands.modelPageSize);
			const searchPageCommands = matchPage.fallbackCommands.map((command) => command.replace("/model page", `/model ${queryText} page`));
			await this.dependencies.reply(
				message,
				[
					"## 未切换模型",
					"",
					`找到 ${matchPage.total} 个匹配项（${matchPage.page}/${matchPage.totalPages}），请发送完整模型：`,
					"",
					...matchPage.models.map((model, index) => `${matchPage.offset + index + 1}. \`${model.provider}/${model.id}\``),
					"",
					searchPageCommands.length
						? `发送 \`${searchPageCommands.join("\` 或 \`")}\` 翻页。`
						: "请缩小搜索词，或发送完整的 `provider/model` 切换。",
				].join("\n"),
				this.searchModelKeyboard(message, matchPage, queryText),
			);
			return;
		}
		const match = matches[0]!;
		const selected = await session.setModel(match.provider, match.id);
		await this.dependencies.reply(
			message,
			`## 已切换 QQ 会话模型\n\n- 模型：\`${selected.provider}/${selected.id}\`\n- 输入：${selected.input.join("、")}\n- 思考等级：${session.thinkingLevel()}\n\n继续发送问题即可。`,
			this.helpKeyboard(message),
		);
	}

	private async handleThinking(message: QQInboundMessage, requested?: string): Promise<void> {
		const session = await this.dependencies.getConversation(message);
		if (!requested) {
			await this.dependencies.reply(
				message,
				`## QQ 会话思考等级\n\n当前：**${session.thinkingLevel()}**\n\n可选：${session.availableThinkingLevels().map((level) => `\`${level}\``).join("、")}\n\n示例：\`/thinking high\``,
				this.thinkingKeyboard(message, session.availableThinkingLevels()),
			);
			return;
		}
		if (!session.availableThinkingLevels().includes(requested.toLowerCase())) {
			throw new Error(`当前模型不支持思考等级“${requested}”；可选：${session.availableThinkingLevels().join("、")}`);
		}
		const effective = session.setThinkingLevel(requested.toLowerCase());
		await this.dependencies.reply(message, `## 已更新 QQ 会话\n\n思考等级：**${effective}**`);
	}

	private async handleNew(message: QQInboundMessage, name: string): Promise<void> {
		const session = await this.dependencies.getConversation(message);
		if (session.isStreaming() || this.dependencies.hasActiveOrQueuedConversation(message)) {
			throw new Error("当前 QQ 任务仍在执行或等待；请先发送 /stop，再发送 /new");
		}
		const created = await session.newSession(name);
		const model = session.currentModel();
		await this.dependencies.reply(
			message,
			`## 已新建 QQ 会话\n\n- 会话：${created.name ? `**${created.name}**` : "未命名"}\n- ID：\`${shortId(created.id)}\`\n- 模型：\`${model ? `${model.provider}/${model.id}` : "unknown"}\`\n\n直接发送新任务即可；旧会话仍保存在历史中。`,
			this.helpKeyboard(message),
		);
	}

	private async handleSessions(message: QQInboundMessage, query: string): Promise<void> {
		const session = await this.dependencies.getConversation(message);
		const all = await session.listSessions();
		const normalized = query.trim().toLowerCase();
		const sessions = (normalized && !/^\d+$/.test(normalized) ? all.filter((entry) => sessionMatches(entry, normalized)) : all)
			.slice(0, this.dependencies.config().commands.maxListItems);
		if (!sessions.length) {
			await this.dependencies.reply(message, "## QQ 会话\n\n没有找到可恢复的历史会话。发送 `/new` 创建一个新会话。");
			return;
		}
		const currentId = session.sessionId();
		await this.dependencies.reply(
			message,
			["## QQ 会话", "", ...sessions.map((entry, index) => formatSessionLine(entry, index, currentId)), "", "发送 `/resume 短ID` 恢复。"].join("\n"),
			this.sessionsKeyboard(message, sessions),
		);
	}

	private async handleResume(message: QQInboundMessage, selector?: string): Promise<void> {
		if (!selector) {
			await this.handleSessions(message, "");
			return;
		}
		const session = await this.dependencies.getConversation(message);
		if (session.isStreaming() || this.dependencies.hasActiveOrQueuedConversation(message)) {
			throw new Error("当前 QQ 任务仍在执行或等待；请先发送 /stop，再恢复会话");
		}
		const sessions = await session.listSessions();
		const normalized = selector.toLowerCase();
		const matches = /^\d+$/.test(normalized)
			? sessions.slice(0, this.dependencies.config().commands.maxListItems).filter((_entry, index) => index === Number(normalized) - 1)
			: sessions.filter((entry) => {
				const compactId = entry.id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
				return compactId.startsWith(normalized) || compactId.endsWith(normalized) || entry.name?.toLowerCase() === normalized;
			});
		if (!matches.length) throw new Error(`没有找到短 ID 或名称为“${selector}”的 QQ 会话；请重新发送 /sessions`);
		if (matches.length > 1) throw new Error(`“${selector}”匹配多个 QQ 会话；请使用更完整的短 ID`);
		const match = matches[0]!;
		if (match.id === session.sessionId()) {
			await this.dependencies.reply(message, `当前已经是 QQ 会话 \`${shortId(match.id)}\`，无需切换。`);
			return;
		}
		const resumed = await session.resumeSession(match.path);
		const model = session.currentModel();
		await this.dependencies.reply(
			message,
			`## 已恢复 QQ 会话\n\n- 会话：${resumed.name ? `**${resumed.name}**` : "未命名"}\n- ID：\`${shortId(resumed.id)}\`\n- 模型：\`${model ? `${model.provider}/${model.id}` : "unknown"}\`\n\n后续消息会继续进入该 QQ 会话。`,
		);
	}

	private async handleName(message: QQInboundMessage, name: string): Promise<void> {
		if (!name.trim()) throw new Error("会话名称不能为空；示例：/name 修复登录问题");
		const session = await this.dependencies.getConversation(message);
		const saved = session.setSessionName(name);
		await this.dependencies.reply(message, `已将当前 QQ 会话命名为：**${escapeMarkdownInline(saved)}**`);
	}

	private async handleCompact(message: QQInboundMessage, instructions: string): Promise<void> {
		const session = await this.dependencies.getConversation(message);
		const result = await session.compact(instructions);
		await this.dependencies.reply(
			message,
			`## QQ 会话压缩完成\n\n${result.tokensBefore ? `压缩前上下文约 ${result.tokensBefore} tokens。` : "较早内容已汇总，完整历史仍保存在会话文件中。"}`,
		);
	}

	private async handleStop(message: QQInboundMessage): Promise<void> {
		const { removed, wasRunning } = await this.dependencies.stopConversation(message);
		await this.dependencies.reply(
			message,
			wasRunning || removed
				? `## 已停止 QQ 任务\n\n${wasRunning ? "当前生成已中止。" : ""}${removed ? ` 已移除 ${removed} 条待处理消息。` : ""}\n\nQQ 会话历史已保留。`
				: "当前 QQ 会话没有正在执行或等待的任务。",
		);
	}

	private commandHelp(command?: string): string {
		const detail = command?.toLowerCase();
		const usages: Record<string, string> = {
			model: "`/model` 查看当前和可用模型；`/model provider/model` 切换 QQ 会话模型。",
			thinking: "`/thinking` 查看等级；`/thinking high` 修改 QQ 会话思考等级。",
			new: "`/new [名称]` 新建 QQ 会话。旧会话会保留；运行中请先 `/stop`。",
			sessions: "`/sessions [关键词]` 查看或搜索当前 QQ 对话的历史会话。",
			resume: "`/resume <短ID|唯一名称>` 恢复 QQ 会话。先用 `/sessions` 获取短 ID。",
			name: "`/name <名称>` 命名当前 QQ 会话。",
			compact: "`/compact [附加要求]` 压缩当前 QQ 会话上下文。",
			stop: "`/stop` 中止当前 QQ 任务并移除该对话尚未处理的消息。",
		};
		if (detail && usages[detail]) return `## /${detail}\n\n${usages[detail]}`;
		return [
			"## QQ Agent 命令",
			"",
			"- `/status` 当前模型、QQ 会话和运行状态",
			"- `/model [查询]` 查看或切换模型",
			"- `/thinking [等级]` 查看或修改思考等级",
			"- `/new [名称]` 新建 QQ 会话",
			"- `/sessions [关键词]` 查看历史 QQ 会话",
			"- `/resume <短ID>` 恢复 QQ 会话",
			"- `/name <名称>` 命名当前 QQ 会话",
			"- `/compact [要求]` 压缩上下文",
			"- `/stop` 停止当前任务",
			"",
			"这些命令只管理隔离的 **QQ 会话**，不会切换电脑终端里的本地 Pi 会话。",
		].join("\n");
	}

	private async statusText(message: QQInboundMessage): Promise<string> {
		const session = await this.dependencies.getConversation(message);
		const model = session.currentModel();
		const config = this.dependencies.config();
		return [
			"## QQ Agent 状态",
			"",
			`- 连接：${this.dependencies.connectionState() === "connected" ? "已连接" : this.dependencies.connectionState()}`,
			`- 会话：${session.sessionName() ? `**${escapeMarkdownInline(session.sessionName() ?? "")}**` : "未命名"} (\`${shortId(session.sessionId())}\`)`,
			`- 模型：\`${model ? `${model.provider}/${model.id}` : "unknown"}\``,
			`- 思考：\`${session.thinkingLevel()}\``,
			`- 当前任务：${session.isStreaming() ? "执行中" : "空闲"}`,
			`- 等待消息：${this.dependencies.queueSize()}`,
			`- 历史模式：${config.sessions.mode === "persistent" ? "持久化" : "内存"}`,
			`- 宿主：${config.startup.keepAcrossLocalSessions ? "本地会话切换保持" : "会话级"}`,
		].join("\n");
	}

	private helpKeyboard(message: QQInboundMessage): QQKeyboard | undefined {
		return this.keyboard(message, [
			[{ label: "当前状态", command: "/status", primary: true }, { label: "切换模型", command: "/model" }],
			[{ label: "新建会话", command: "/new" }, { label: "历史会话", command: "/sessions" }],
			[{ label: "停止任务", command: "/stop" }, { label: "帮助", command: "/help" }],
		]);
	}

	private modelKeyboard(message: QQInboundMessage, page: ModelPage): QQKeyboard | undefined {
		return this.keyboard(message, page.keyboardRows);
	}

	private searchModelKeyboard(message: QQInboundMessage, page: ModelPage, query: string): QQKeyboard | undefined {
		const rows = page.keyboardRows.map((row) => row.map((button) => ({ ...button })));
		const navigation = rows.at(-2);
		if (page.totalPages > 1 && navigation) {
			for (const button of navigation) button.command = button.command.replace("/model page", `/model ${query} page`);
		}
		return this.keyboard(message, rows);
	}

	private thinkingKeyboard(message: QQInboundMessage, levels: string[]): QQKeyboard | undefined {
		const rows: QQCommandButton[][] = [];
		for (let index = 0; index < levels.length; index += 2) {
			rows.push(levels.slice(index, index + 2).map((level) => ({ label: level, command: `/thinking ${level}` })));
		}
		return this.keyboard(message, rows);
	}

	private sessionsKeyboard(message: QQInboundMessage, sessions: QQSessionInfo[]): QQKeyboard | undefined {
		const rows: QQCommandButton[][] = [];
		for (let index = 0; index < sessions.length; index += 2) {
			rows.push(sessions.slice(index, index + 2).map((session) => ({
				label: sessionButtonLabel(session),
				command: `/resume ${shortId(session.id)}`,
			})));
		}
		rows.push([{ label: "新建会话", command: "/new", primary: true }, { label: "返回帮助", command: "/help" }]);
		return this.keyboard(message, rows);
	}
}

function modelMatches(model: QQModelInfo, query: string): boolean {
	return `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query);
}

function rankModels(models: QQModelInfo[], query: string): QQModelInfo[] {
	return [...models].sort((left, right) => {
		if (query) {
			const leftId = `${left.provider}/${left.id}`.toLowerCase();
			const rightId = `${right.provider}/${right.id}`.toLowerCase();
			const leftScore = leftId === query ? 0 : leftId.startsWith(query) ? 1 : leftId.includes(query) ? 2 : 3;
			const rightScore = rightId === query ? 0 : rightId.startsWith(query) ? 1 : rightId.includes(query) ? 2 : 3;
			if (leftScore !== rightScore) return leftScore - rightScore;
		}
		return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
	});
}

function sessionMatches(session: QQSessionInfo, query: string): boolean {
	const preview = humanizeSessionPreview(session.firstMessage);
	return `${session.name ?? ""} ${preview} ${humanizeSessionPreview(session.allMessagesText)}`.toLowerCase().includes(query);
}

function formatSessionLine(session: QQSessionInfo, index: number, currentId: string): string {
	const title = escapeMarkdownInline(sessionDisplayTitle(session));
	const current = session.id === currentId ? " · 当前" : "";
	const preview = humanizeSessionPreview(session.firstMessage);
	const summary = preview && preview !== session.name ? `\n   摘要：${escapeMarkdownInline(preview)}` : "";
	return `${index + 1}. **${title}**${current}\n   \`${shortId(session.id)}\` · ${formatSessionTime(session.modified)} · ${session.messageCount} 条消息${summary}`;
}

function sessionDisplayTitle(session: QQSessionInfo): string {
	if (session.name?.trim()) return session.name.trim();
	return humanizeSessionPreview(session.firstMessage) || "未命名会话";
}

function sessionButtonLabel(session: QQSessionInfo): string {
	const title = sessionDisplayTitle(session);
	if (session.name?.trim()) return title.slice(0, 14);
	const id = shortId(session.id);
	const preview = humanizeSessionPreview(session.firstMessage);
	return preview ? `${preview.slice(0, 8)}·${id}`.slice(0, 14) : id;
}

function formatSessionTime(value: Date): string {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function shortId(value: string): string {
	const compact = value.replace(/[^a-zA-Z0-9]/g, "");
	return compact.slice(-8) || "unknown";
}

function escapeMarkdownInline(value: string): string {
	return value.replace(/[\\`*_[\]~]/g, "\\$&");
}

function sanitizeCommandError(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}
