import { randomUUID } from "node:crypto";

import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
} from "@earendil-works/pi-coding-agent";

import { deliverFormattedReply } from "../application/deliver-reply.ts";
import type { PiAgentQQBotConfig, QQInboundMessage, QQReplyTarget } from "../application/ports.ts";
import { ReplyBudget } from "../domain/reply-budget.ts";
import { NativeSessionLinkState, type TurnOrigin } from "../domain/native-session-link.ts";
import { validateEnabled } from "../infrastructure/config/normalize-config.ts";
import { AttachmentPipeline } from "../infrastructure/media/attachment-pipeline.ts";
import { QQOutboundDeliveryContext, type QQOutboundKind } from "../infrastructure/media/outbound-media.ts";
import { QQApi, QQApiError } from "../infrastructure/qq/api.ts";
import { QQAuth } from "../infrastructure/qq/auth.ts";
import { QQGateway, type QQGatewayCallbacks } from "../infrastructure/qq/gateway.ts";
import { normalizeCommandText, parseQQCommand } from "../presentation/qq/command-parser.ts";
import { formatQQReply } from "../presentation/qq/reply-formatter.ts";
import { PiCommandBridge } from "./pi-command-bridge.ts";
import { GatewayOwnership } from "./gateway-ownership.ts";
import type { LogicalLink } from "../domain/native-session-link.ts";

const UNLINKED_MESSAGE = "QQ 已连接，但尚未绑定到 Pi。请让本机操作员运行 /qqbot-link。";
const LOCAL_ONLY_DENIAL = "该命令只能由本机 Pi 终端执行。";
const BUSY_MESSAGE = "Pi 当前等待队列已满，请稍后重试。";
const EMPTY_REPLY = "本次没有生成可发送的文本回复。";
const LOCAL_ONLY_COMMANDS = new Set([
	"qqbot-start",
	"qqbot-stop",
	"qqbot-link",
	"qqbot-unlink",
	"qqbot-takeover",
]);
const REMOTE_COMMANDS = new Set([
	"new",
	"sessions",
	"resume",
	"name",
	"compact",
	"model",
	"thinking",
	"stop",
	"status",
	"help",
]);

export interface GatewayControl {
	connect(): Promise<void>;
	close(): void;
	reconnect(): Promise<void>;
}

export interface QQReplyApi {
	sendText(target: QQReplyTarget, content: string, sequence: number): Promise<void>;
	sendMarkdown(target: QQReplyTarget, content: string, sequence: number): Promise<void>;
}

export interface NativeTransport {
	gateway: GatewayControl;
	api: QQReplyApi;
}

export interface NativeSessionRuntimeOptions {
	state?: NativeSessionLinkState;
	bridge?: PiCommandBridge;
	createTransport?: (config: PiAgentQQBotConfig, callbacks: QQGatewayCallbacks) => NativeTransport;
	createAttachmentPipeline?: (config: PiAgentQQBotConfig) => AttachmentPipeline;
	createOwnership?: (appId: string, userOpenId: string, onRelease: () => Promise<LogicalLink | undefined>) => OwnershipControl;
}

export interface OwnershipControl {
	claim(policy: "ask" | "takeover", confirm?: (record: { pid: number }) => Promise<boolean>): Promise<{ transferredLink?: LogicalLink | undefined }>;
	release(): Promise<void>;
}

export interface StartOptions {
	forceTakeover?: boolean;
	confirmTakeover?: (record: { pid: number }) => Promise<boolean>;
}

interface PendingQQInjection {
	prompt: string;
	origin: Extract<TurnOrigin, { source: "qq" }>;
	target: QQReplyTarget;
}

export class NativeSessionRuntime {
	readonly state: NativeSessionLinkState;
	readonly bridge: PiCommandBridge;
	private config: PiAgentQQBotConfig | undefined;
	private pi: ExtensionAPI | undefined;
	private transport: NativeTransport | undefined;
	private currentContext: ExtensionContext | undefined;
	private currentSession: { sessionId: string; sessionFile?: string | undefined } | undefined;
	private readonly pendingQQ: PendingQQInjection[] = [];
	private readonly acceptedOrigins: TurnOrigin[] = [];
	private readonly qqTargets = new Map<string, QQReplyTarget>();
	private readonly qqMessages = new Map<string, QQInboundMessage>();
	private readonly replyBudgets = new Map<string, ReplyBudget>();
	private readonly outboundDeliveries = new Map<string, QQOutboundDeliveryContext>();
	private readonly agentOutputs: string[] = [];
	private readonly createTransport: NonNullable<NativeSessionRuntimeOptions["createTransport"]>;
	private readonly createAttachmentPipeline: NonNullable<NativeSessionRuntimeOptions["createAttachmentPipeline"]>;
	private readonly createOwnership: NonNullable<NativeSessionRuntimeOptions["createOwnership"]>;
	private ownership: OwnershipControl | undefined;
	private startPromise: Promise<void> | undefined;
	private stopPromise: Promise<void> | undefined;

	constructor(options: NativeSessionRuntimeOptions = {}) {
		this.state = options.state ?? new NativeSessionLinkState();
		this.bridge = options.bridge ?? new PiCommandBridge();
		this.createTransport = options.createTransport ?? defaultTransport;
		this.createAttachmentPipeline = options.createAttachmentPipeline ?? ((config) => new AttachmentPipeline(config, this.state.runtimeId));
		this.createOwnership = options.createOwnership ?? ((appId, userOpenId, onRelease) => new GatewayOwnership(appId, userOpenId, onRelease));
	}

	bindExtension(pi: ExtensionAPI): void {
		this.pi = pi;
		this.bridge.bindExtension(pi);
	}

	configure(config: PiAgentQQBotConfig): void {
		this.config = config;
	}

	onSessionStart(ctx: ExtensionContext): void {
		this.currentContext = ctx;
		this.bridge.observeSessionContext(ctx);
		const currentSession = sessionIdentity(ctx);
		this.currentSession = currentSession;
		this.state.updateSession(this.currentSession);
	}

	async start(ctx: ExtensionCommandContext, options: StartOptions = {}): Promise<void> {
		this.bridge.captureCommandContext(ctx);
		if (this.state.gateway === "running") return;
		if (this.startPromise) return this.startPromise;
		const config = this.requireConfig();
		const invalid = validateEnabled(config);
		if (invalid) throw new Error(invalid);
		const userOpenId = config.allowUsers?.[0]!;
		const currentSession = sessionIdentity(ctx);
		this.currentSession = currentSession;
		this.state.setGateway("starting");
		this.startPromise = (async () => {
			try {
				if (!this.ownership) {
					this.ownership = this.createOwnership(config.appId, userOpenId, async () => {
						const transferable = this.state.link ? { ...this.state.link } : undefined;
						this.state.unlink();
						await this.stop();
						return transferable;
					});
				}
				const claim = await this.ownership.claim(
					options.forceTakeover ? "takeover" : config.link.conflictPolicy,
					options.confirmTakeover,
				);
				if (claim.transferredLink) {
					this.state.adopt(claim.transferredLink);
					this.state.updateSession(currentSession);
				}
				const transport = this.createTransport(config, {
					onInbound: (message) => { void this.handleInbound(message); },
					onState: (connection, detail) => {
					if (connection === "connected") this.state.setGateway("running");
					else if (connection === "connecting") this.state.setGateway("starting");
					else if (connection === "error") this.state.setGateway("failed");
					else if (this.state.gateway !== "stopping") this.state.setGateway("stopped");
					if (detail && config.debug) console.error(`[pi-agent-qqbot] ${detail}`);
				},
				log: (message) => { if (config.debug) console.error(`[pi-agent-qqbot] ${message}`); },
				});
				this.transport = transport;
				await transport.gateway.connect();
			} catch (error) {
				this.transport = undefined;
				this.state.setGateway("failed");
				await this.ownership?.release().catch(() => undefined);
				this.ownership = undefined;
				throw error;
			} finally {
				this.startPromise = undefined;
			}
		})();
		return this.startPromise;
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (!this.transport) {
			this.state.setGateway("stopped");
			return;
		}
		this.state.setGateway("stopping");
		this.stopPromise = Promise.resolve().then(() => {
			this.transport?.gateway.close();
			this.transport = undefined;
			this.state.setGateway("stopped");
		}).finally(() => { this.stopPromise = undefined; });
		return this.stopPromise;
	}

	link(ctx: ExtensionCommandContext): Readonly<NonNullable<NativeSessionLinkState["link"]>> {
		if (this.state.gateway !== "running") throw new Error("QQ Gateway must be running before /qqbot-link");
		this.bridge.captureCommandContext(ctx);
		const config = this.requireConfig();
		const userOpenId = config.allowUsers?.[0];
		if (!userOpenId) throw new Error("single QQ user is not configured");
		this.currentSession = sessionIdentity(ctx);
		return this.state.bind(config.appId, userOpenId, this.currentSession);
	}

	unlink(): void {
		this.state.unlink();
	}

	async shutdownProcess(): Promise<void> {
		this.state.unlink();
		await this.stop();
		await this.ownership?.release();
		this.ownership = undefined;
		this.pendingQQ.length = 0;
		this.acceptedOrigins.length = 0;
		this.agentOutputs.length = 0;
		this.qqTargets.clear();
		this.qqMessages.clear();
		this.replyBudgets.clear();
		for (const delivery of this.outboundDeliveries.values()) delivery.close();
		this.outboundDeliveries.clear();
	}

	onInput(event: InputEvent): void {
		if (event.source === "extension") {
			const pending = this.pendingQQ[0];
			if (pending && pending.prompt === event.text) {
				this.pendingQQ.shift();
				this.acceptedOrigins.push(pending.origin);
				return;
			}
		}
		this.acceptedOrigins.push({ source: "terminal" });
	}

	onAgentEnd(event: AgentEndEvent): void {
		this.agentOutputs.push(extractLastAssistantText(event.messages));
	}

	async onAgentSettled(): Promise<void> {
		const origin = this.acceptedOrigins.shift();
		const text = this.agentOutputs.shift() ?? "";
		if (!origin || origin.source !== "qq") return;
		const target = this.qqTargets.get(origin.messageId);
		const budget = this.replyBudgets.get(origin.messageId);
		try {
			if (!this.state.isCurrentQQOrigin(origin)) return;
			if (!target || this.state.gateway !== "running") return;
			await this.sendReply(target, text.trim() || EMPTY_REPLY, budget);
		} finally {
			this.releaseQQMessage(origin.messageId);
		}
	}

	async sendLocalFile(path: string, kind: QQOutboundKind = "auto") {
		const origin = this.acceptedOrigins[0];
		if (!origin || !this.state.isCurrentQQOrigin(origin)) throw new Error("No active QQ delivery context (delivery_context_closed)");
		const message = this.qqMessages.get(origin.messageId);
		const target = this.qqTargets.get(origin.messageId);
		const transport = this.transport;
		const context = this.currentContext;
		if (!message || !target || !transport || !context) throw new Error("No active QQ delivery context (delivery_context_closed)");
		let delivery = this.outboundDeliveries.get(origin.messageId);
		if (!delivery) {
			const budget = this.replyBudgets.get(origin.messageId) ?? new ReplyBudget(4);
			this.replyBudgets.set(origin.messageId, budget);
			delivery = new QQOutboundDeliveryContext({
				config: this.requireConfig(),
				cwd: context.cwd,
				message,
				target,
				api: transport.api as QQApi,
				fake: false,
				hasMessageSequenceCapacity: () => budget.remaining > 1,
				reserveMessageSequence: () => budget.reserve("media", { keepFinal: true }),
			});
			this.outboundDeliveries.set(origin.messageId, delivery);
		}
		return delivery.sendLocalFile(path, kind);
	}

	async handleInbound(message: QQInboundMessage): Promise<void> {
		if (this.state.gateway !== "running") return;
		const config = this.requireConfig();
		const allowedUser = config.allowUsers?.[0];
		if (message.type !== "private" || !allowedUser || message.userOpenId !== allowedUser) return;
		if (!this.state.link) {
			await this.sendReply(targetFor(message), UNLINKED_MESSAGE);
			return;
		}
		const normalized = normalizeCommandText(message.text);
		if (normalized.startsWith("/")) {
			await this.handleRemoteCommand(message, normalized);
			return;
		}
		if (!normalized && message.attachments.length === 0) return;
		const queuedQQ = this.pendingQQ.length + this.acceptedOrigins.filter((origin) => origin.source === "qq").length;
		if (queuedQQ >= (config.maxQueueSize ?? 20)) {
			await this.sendReply(targetFor(message), BUSY_MESSAGE);
			return;
		}
		const prepared = await this.createAttachmentPipeline(config).prepare(message, new AbortController().signal);
		try {
			if (prepared.images.length > 0 && this.currentContext?.model?.input.includes("image") !== true) {
				await this.sendReply(targetFor(message), "当前 Pi 模型不支持图片输入；本条消息未提交，请切换到支持视觉的模型后重试。");
				return;
			}
			const link = this.state.link;
			if (!link) return;
			const origin = { source: "qq" as const, generation: link.generation, messageId: message.id };
			const target = targetFor(message);
			this.pendingQQ.push({ prompt: prepared.prompt, origin, target });
			this.qqTargets.set(message.id, target);
			this.qqMessages.set(message.id, message);
			this.replyBudgets.set(message.id, new ReplyBudget(4));
			const content: Parameters<ExtensionAPI["sendUserMessage"]>[0] = [
				{ type: "text", text: prepared.prompt },
				...prepared.images,
			];
			try {
				this.requirePi().sendUserMessage(content, {
					...(this.currentContext?.isIdle() === false ? { deliverAs: "followUp" as const } : {}),
				});
			} catch (error) {
				const index = this.pendingQQ.findIndex((entry) => entry.origin.messageId === message.id);
				if (index >= 0) this.pendingQQ.splice(index, 1);
				this.releaseQQMessage(message.id);
				throw error;
			}
		} finally {
			await prepared.cleanup();
		}
	}

	statusText(): string {
		const link = this.state.link;
		let native: ReturnType<PiCommandBridge["status"]> | undefined;
		try { native = this.bridge.status(); } catch { native = undefined; }
		return [
			`Gateway: ${this.state.gateway}`,
			`Link: ${link ? "linked" : "unlinked"}`,
			`Session: ${native?.sessionId ?? link?.currentSessionId ?? "unknown"}`,
			`Model: ${native?.model ?? "unknown"}`,
			`Origin queue: ${this.acceptedOrigins.length}`,
		].join("\n");
	}

	private async handleRemoteCommand(message: QQInboundMessage, text: string): Promise<void> {
		let command;
		try { command = parseQQCommand(text); } catch (error) {
			await this.sendReply(targetFor(message), safeError(error));
			return;
		}
		if (!command) return;
		if (LOCAL_ONLY_COMMANDS.has(command.name)) {
			await this.sendReply(targetFor(message), LOCAL_ONLY_DENIAL);
			return;
		}
		if (!REMOTE_COMMANDS.has(command.name)) {
			await this.sendReply(targetFor(message), `未知命令 /${command.name}。发送 /help 查看可用命令。`);
			return;
		}
		try {
			const reply = await this.executeRemoteCommand(command.name, command.rawArgs);
			await this.sendReply(targetFor(message), reply);
		} catch (error) {
			await this.sendReply(targetFor(message), `命令未执行：${safeError(error)}`);
		}
	}

	private async executeRemoteCommand(name: string, args: string): Promise<string> {
		switch (name) {
			case "new":
				await this.bridge.newSession(args || undefined);
				return `已新建当前 Pi 会话${args ? `：${args}` : ""}。`;
			case "sessions": {
				const sessions = await this.bridge.listSessions(args);
				if (!sessions.length) return "没有找到可恢复的 Pi 会话。";
				return ["当前 Pi 的会话：", ...sessions.slice(0, this.requireConfig().commands.maxListItems).map((entry) => `- ${entry.name ?? "未命名"} (${shortId(entry.id)})`)].join("\n");
			}
			case "resume":
				await this.bridge.resumeSession(args);
				return "已恢复指定的 Pi 会话。";
			case "name":
				this.bridge.setSessionName(args);
				return `当前 Pi 会话已命名为：${args.trim()}`;
			case "compact":
				await this.bridge.compact(args || undefined);
				return "当前 Pi 会话已完成压缩。";
			case "model": {
				if (!args) {
					const current = this.bridge.status().model ?? "unknown";
					const models = this.bridge.listModels().slice(0, this.requireConfig().commands.modelPageSize);
					return [`当前模型：${current}`, ...models.map((model) => `- ${model.provider}/${model.id}`)].join("\n");
				}
				return `已切换模型：${await this.bridge.setModel(args)}`;
			}
			case "thinking":
				return `当前思考等级：${this.bridge.setThinking(args || undefined)}`;
			case "stop":
				this.bridge.stopCurrentTurn();
				return "已请求停止当前 Pi 回合。";
			case "status":
				return this.statusText();
			case "help":
				return "可用命令：/new /sessions /resume /name /compact /model /thinking /stop /status /help";
			default:
				throw new Error("unsupported command");
		}
	}

	private async sendReply(target: QQReplyTarget, text: string, budget = new ReplyBudget(4)): Promise<void> {
		const transport = this.transport;
		if (!transport) return;
		const config = this.requireConfig();
		const formatted = formatQQReply(`${config.replyPrefix ?? ""}${text}`, config.replyFormat);
		await deliverFormattedReply(transport.api, budget, {
			target,
			formatted,
			useMarkdown: config.replyFormat !== "plain",
			canFallback: (error) => error instanceof QQApiError && error.status >= 400 && error.status < 500,
		});
	}

	private requireConfig(): PiAgentQQBotConfig {
		if (!this.config) throw new Error("pi-agent-qqbot configuration is not loaded");
		return this.config;
	}

	private releaseQQMessage(messageId: string): void {
		this.qqTargets.delete(messageId);
		this.qqMessages.delete(messageId);
		this.replyBudgets.delete(messageId);
		this.outboundDeliveries.get(messageId)?.close();
		this.outboundDeliveries.delete(messageId);
	}

	private requirePi(): ExtensionAPI {
		if (!this.pi) throw new Error("native Pi extension API is not bound");
		return this.pi;
	}
}

function defaultTransport(config: PiAgentQQBotConfig, callbacks: QQGatewayCallbacks): NativeTransport {
	const auth = new QQAuth(config.appId, config.clientSecret);
	return {
		api: new QQApi(auth, { sandbox: config.sandbox ?? true }),
		gateway: new QQGateway(auth, { sandbox: config.sandbox ?? true }, callbacks),
	};
}

function sessionIdentity(ctx: ExtensionContext): { sessionId: string; sessionFile?: string | undefined } {
	const sessionFile = ctx.sessionManager.getSessionFile();
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		...(sessionFile ? { sessionFile } : {}),
	};
}

function targetFor(message: QQInboundMessage): QQReplyTarget {
	return {
		type: "private",
		userOpenId: message.userOpenId,
		msgId: message.id,
		createdAt: message.receivedAt,
	};
}

function extractLastAssistantText(messages: AgentEndEvent["messages"]): string {
	const assistant = [...messages].reverse().find((message) => message.role === "assistant");
	if (!assistant || !Array.isArray(assistant.content)) return "";
	return assistant.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("")
		.trim();
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error))
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
}

function shortId(id: string): string {
	const compact = id.replace(/[^a-z0-9]/gi, "");
	return compact.slice(-8) || randomUUID().slice(0, 8);
}
