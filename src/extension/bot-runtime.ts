/**
 * PiAgentQQBotRuntime: wires the QQ gateway/api to the Pi agent.
 *
 * Responsibilities:
 *  - validate the allowlist for inbound messages
 *  - serialize QQ conversations through a single FIFO queue
 *  - run each message in the isolated QQ AgentSession
 *  - send the final assistant response back as a passive QQ reply
 *  - optionally mirror process-local events to the Pi TUI that ran /qqbot-start
 *
 * The observer is UI-only and optional. QQ handling never falls back to the
 * local Pi session, and observer failures never affect QQ replies.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { AgentTurnController } from "./agent-turn-controller";
import { RemoteCommandController } from "./remote-command-controller";
import { normalizeCommandText } from "../presentation/qq/command-parser";
import { ConversationRegistry } from "../infrastructure/pi/conversation-registry";
import { QQAccessRequestStore, type QQAccessRequest } from "../application/access-requests";
import { deliverFormattedReply, ReplyDeliveryError } from "../application/deliver-reply";
import { AttachmentPipeline, classifyAttachment } from "../infrastructure/media/attachment-pipeline";
import { maskAppId } from "../infrastructure/config/normalize-config";
import { QQApi, QQApiError } from "../infrastructure/qq/api";
import { QQAuth } from "../infrastructure/qq/auth";
import { QQGateway } from "../infrastructure/qq/gateway";
import { resolveSdkEntry } from "../infrastructure/pi/agent-session";
import { MessageQueue } from "../application/message-queue";
import { MessageDedupe } from "../domain/message-dedupe.ts";
import { ReplyBudget, ReplyBudgetPool } from "../domain/reply-budget.ts";
import { formatQQReply, QQ_MAX_REPLY_CHUNKS } from "../presentation/qq/reply-formatter";
import type {
	ConnectionState,
	PiAgentQQBotConfig,
	QQConversationObserver,
	QQInboundMessage,
	QQKeyboard,
	QQReplyTarget,
	QQTerminalEvent,
} from "../application/ports";

const SUMMARY_MAX = 120;
const MAX_RETAINED_REPLY_BUDGETS = 256;

interface InboundSummary {
	type: "private" | "group";
	user: string;
	group?: string;
	text: string;
	attachments: string[];
	at: number;
	authorized?: boolean;
}

interface OutboundSummary {
	type: "private" | "group";
	user: string;
	group?: string;
	text: string;
	at: number;
	fake?: boolean;
}

export class PiAgentQQBotRuntime {
	private config: PiAgentQQBotConfig;

	private auth?: QQAuth;
	private gateway?: QQGateway;
	private api?: QQApi;
	private readonly queue: MessageQueue;
	private readonly attachmentPipeline: AttachmentPipeline;
	private readonly seenMessages = new MessageDedupe(2 * 60 * 60 * 1000, 2000, { now: () => Date.now() });
	private readonly accessRequests = new QQAccessRequestStore();
	private readonly commands: RemoteCommandController;
	private readonly agentTurns: AgentTurnController;
	private conversations?: ConversationRegistry;
	private runtimeAbort = new AbortController();
	private activeRunAbort?: AbortController;
	private agentCwd = process.cwd();

	private ctx?: ExtensionContext;
	private running = false;
	private activeTarget?: QQReplyTarget;
	private activeFake = false;

	private state: ConnectionState = "disconnected";
	private stateDetail?: string;
	private lastError?: string;
	private lastAttachmentError?: string;
	private activeAttachmentStatus?: string;
	private lastOutboundMediaError?: string;
	private activeOutboundMediaStatus?: string;
	private lastInbound?: InboundSummary;
	private lastOutbound?: OutboundSummary;

	private pumpScheduled = false;
	private pumpTimer?: ReturnType<typeof setTimeout>;
	private fakeCounter = 0;
	private observer?: QQConversationObserver;
	/** One bounded passive-reply budget owns every reservation for an inbound message. */
	private readonly replyBudgets = new ReplyBudgetPool(QQ_MAX_REPLY_CHUNKS, MAX_RETAINED_REPLY_BUDGETS);

	constructor(config: PiAgentQQBotConfig) {
		this.config = config;
		this.queue = new MessageQueue(config.maxQueueSize ?? 20);
		this.attachmentPipeline = new AttachmentPipeline(config, randomUUID());
		this.commands = new RemoteCommandController({
			config: () => this.config,
			connectionState: () => this.state,
			queueSize: () => this.queue.size,
			getConversation: async (message) => {
				if (!this.conversations) throw new Error("QQ 会话运行时尚未就绪");
				return this.conversations.get(message);
			},
			hasActiveOrQueuedConversation: (message) => this.hasActiveOrQueuedConversation(message),
			stopConversation: (message) => this.stopConversation(message),
			reply: (message, text, keyboard) => this.replyToQQ(message, text, keyboard),
			lastSummary: () => this.lastSummary(),
			onError: (message, commandName, detail) => {
				this.lastError = `command /${commandName} failed: ${detail}`;
				this.emit({ kind: "error", messageId: message.id, stage: "command", message: this.lastError, at: Date.now() });
			},
		});
		this.agentTurns = new AgentTurnController(this.attachmentPipeline, {
			config: () => this.config,
			api: () => this.api,
			cwd: () => this.agentCwd,
			getConversation: async (message) => {
				if (!this.conversations) throw new Error("conversation registry not ready");
				return this.conversations.get(message);
			},
			beginRun: (message, target, controller) => this.beginAgentRun(message, target, controller),
			finishRun: (message, controller) => this.finishAgentRun(message, controller),
			isRunActive: (messageId) => this.running && this.activeTarget?.msgId === messageId,
			reply: (message, text) => this.replyToQQ(message, text),
			deliver: (target, text, fake, keyboard, forcePlain) => this.deliverReply(target, text, fake, keyboard, forcePlain),
			errorKeyboard: (message) => this.commandKeyboard(message, [[
				{ label: "当前状态", command: "/status", primary: true },
				{ label: "停止任务", command: "/stop" },
			]]),
			sendProgress: (message) => this.sendProgressAck(message),
			hasMediaCapacity: (messageId) => this.hasMediaReplyCapacity(messageId),
			reserveMediaSequence: (messageId) => this.reserveMediaReplySequence(messageId),
			setAttachmentStatus: (status) => { this.activeAttachmentStatus = status; },
			setAttachmentError: (error) => { this.lastAttachmentError = error; },
			setOutboundStatus: (status) => { this.activeOutboundMediaStatus = status; },
			setOutboundError: (error) => { this.lastOutboundMediaError = error; },
			recordError: (messageId, stage, detail) => {
				this.lastError = detail;
				this.emit({ kind: "error", messageId, stage, message: detail, at: Date.now() });
			},
			emit: (event) => this.emit(event),
			debug: (message) => this.debugLog(message),
		});
	}

	applyRuntimeConfig(config: PiAgentQQBotConfig): void {
		// Gateway credentials, storage, and media boundaries are cold settings and
		// cause Host replacement. These command/display settings are safe to apply
		// to an already connected runtime.
		this.config = {
			...this.config,
			allowUsers: [...(config.allowUsers ?? [])],
			allowGroups: [...(config.allowGroups ?? [])],
			replyPrefix: config.replyPrefix,
			sendBusyNotice: config.sendBusyNotice,
			showProcess: config.showProcess,
			replyFormat: config.replyFormat,
			progress: { ...config.progress },
			outboundMedia: { ...config.outboundMedia, allowedRoots: [...config.outboundMedia.allowedRoots] },
			debug: config.debug,
			commands: { ...config.commands, admins: [...config.commands.admins] },
		};
	}

	applyAccessConfig(config: PiAgentQQBotConfig): void {
		this.applyRuntimeConfig(config);
	}

	attachObserver(observer: QQConversationObserver): void {
		this.observer = observer;
		this.emitRuntimeState();
	}

	detachObserver(observer?: QQConversationObserver): void {
		if (!observer || this.observer === observer) this.observer = undefined;
	}

	isReady(): boolean {
		return this.conversations !== undefined && this.state !== "disconnected";
	}

	isIdle(): boolean {
		return !this.running && this.queue.size === 0;
	}

	async waitForIdle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (!this.isIdle() && Date.now() < deadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
		}
		return this.isIdle();
	}

	/**
	 * Bind or clear the local TUI context used only for optional notifications.
	 * The QQ gateway outlives local sessions, so this must be refreshed on
	 * attach and cleared on detach/shutdown to avoid stale ctx access.
	 */
	bindUiContext(ctx?: ExtensionContext): void {
		this.ctx = ctx;
	}

	async start(ctx: ExtensionContext): Promise<boolean> {
		this.bindUiContext(ctx);
		this.agentCwd = ctx.cwd;
		this.runtimeAbort = new AbortController();
		this.state = "connecting";
		this.emitRuntimeState();

		// Conversation runtimes are created lazily after allowlist admission. This
		// keeps startup fast while preserving strict isolation from the local TUI.
		const sdk = await import(pathToFileURL(resolveSdkEntry()).href);
		this.conversations = new ConversationRegistry(this.config, sdk.getAgentDir(), ctx.cwd);

		this.auth = new QQAuth(this.config.appId, this.config.clientSecret);
		this.api = new QQApi(this.auth, { sandbox: this.config.sandbox ?? true });
		this.gateway = new QQGateway(
			this.auth,
			{ sandbox: this.config.sandbox ?? true },
			{
				onInbound: (msg) => this.handleInbound(msg),
				onState: (state, detail) => {
					this.state = state;
					this.stateDetail = detail;
					if (state === "error" && detail) this.lastError = detail;
					this.emitRuntimeState();
					if (state === "connected") this.notify("pi-agent-qqbot connected", "info");
					if (state === "error") this.notify(`pi-agent-qqbot error: ${detail ?? ""}`, "error");
				},
				log: (m) => this.debugLog(m),
			},
		);
		await this.gateway.connect();
		return true;
	}

	async stop(): Promise<void> {
		this.runtimeAbort.abort(new Error("QQBot stopped"));
		this.activeRunAbort?.abort(new Error("QQBot stopped"));
		this.activeRunAbort = undefined;
		if (this.pumpTimer) clearTimeout(this.pumpTimer);
		this.pumpTimer = undefined;
		this.pumpScheduled = false;
		this.gateway?.close();
		this.gateway = undefined;
		const conversations = this.conversations;
		this.conversations = undefined;
		await conversations?.dispose();
		this.queue.clear();
		this.replyBudgets.clear();
		this.activeTarget = undefined;
		this.activeFake = false;
		this.activeAttachmentStatus = undefined;
		this.activeOutboundMediaStatus = undefined;
		this.running = false;
		this.state = "disconnected";
		this.stateDetail = undefined;
		this.bindUiContext(undefined);
		this.emitRuntimeState();
	}

	async reconnect(): Promise<void> {
		if (!this.gateway) return;
		this.lastError = undefined;
		await this.gateway.reconnect();
	}

	listAccessRequests(): QQAccessRequest[] {
		return this.accessRequests.list();
	}

	approveAccessRequest(code: string): QQAccessRequest | undefined {
		return this.accessRequests.approve(code);
	}

	denyAccessRequest(code: string): QQAccessRequest | undefined {
		return this.accessRequests.deny(code);
	}

	async notifyAccessDecision(request: QQAccessRequest, decision: "user" | "admin" | "denied"): Promise<void> {
		const text = decision === "denied"
			? "## 访问申请未通过\n\n主机管理员没有批准本次申请。"
			: `## 访问申请已批准\n\n权限：**${decision === "admin" ? "管理员" : "普通用户"}**\n\n现在可以重新发送消息。`;
		await this.replyToQQ(request.message, text);
	}

	private emitAccessRequest(request: QQAccessRequest): void {
		this.notify(
			`QQBot 收到新的访问申请\n申请码：${request.code}\n用户：${maskOpenId(request.userOpenId)}\n使用 /qqbot-requests 处理`,
			"warning",
		);
	}

	private async replyToUnauthorizedApplicant(request: QQAccessRequest): Promise<void> {
		await this.replyToQQ(
			request.message,
			`## 已提交访问申请\n\n申请码：\`${request.code}\`\n\n请等待主机管理员确认。申请 10 分钟内有效；批准后请重新发送消息。`,
		).catch((err) => this.debugLog(`access request reply failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	// --- Agent run (isolated QQ session) ------------------------------------

	private beginAgentRun(
		message: QQInboundMessage,
		target: QQReplyTarget,
		controller: AbortController,
	): AbortSignal {
		this.running = true;
		this.activeTarget = target;
		this.activeFake = message.fake === true;
		this.activeRunAbort = controller;
		this.replyBudgets.acquire(message.id, { pin: true });
		this.emit({ kind: "run_start", messageId: message.id, at: Date.now() });
		this.emitRuntimeState();
		return AbortSignal.any([this.runtimeAbort.signal, controller.signal]);
	}

	private finishAgentRun(message: QQInboundMessage, controller: AbortController): void {
		this.running = false;
		this.activeTarget = undefined;
		this.activeFake = false;
		this.activeAttachmentStatus = undefined;
		this.activeOutboundMediaStatus = undefined;
		if (this.activeRunAbort === controller) this.activeRunAbort = undefined;
		this.replyBudgets.release(message.id);
		this.emit({ kind: "run_end", messageId: message.id, at: Date.now() });
		this.emitRuntimeState();
		this.schedulePump();
	}

	private async runOne(message: QQInboundMessage): Promise<void> {
		await this.agentTurns.run(message);
	}

	// --- Inbound -------------------------------------------------------------

	handleInbound(msg: QQInboundMessage): void {
		const allowed = msg.fake === true || isAllowed(this.config, msg);

		// Always record the sender so /qqbot-status and /qqbot-last can reveal the
		// openid even for unauthorized messages (needed to populate the allowlist).
		const attachmentSummary = msg.attachments.map(
			(attachment) => `${classifyAttachment(attachment)}:${sanitizeSummaryFilename(attachment.filename)}`,
		);
		this.lastInbound = {
			type: msg.type,
			user: msg.userOpenId,
			group: msg.groupOpenId,
			// Before approval retain identity/event metadata only. Unauthorized
			// message text and attachment names must not remain in diagnostics.
			text: allowed ? msg.text : "",
			attachments: allowed ? attachmentSummary : [],
			at: msg.receivedAt,
			authorized: allowed,
		};

		if (!msg.text.trim() && msg.attachments.length === 0) {
			this.debugLog("ignored empty message");
			return;
		}
		if (!allowed) {
			this.debugLog(
				`ignored unauthorized ${msg.type} openid=${msg.type === "group" ? msg.groupOpenId : msg.userOpenId}`,
			);
			if (this.config.commands.accessRequests && msg.type === "private") {
				const admission = this.accessRequests.admit(msg);
				if (admission.request && admission.created) {
					this.emitAccessRequest(admission.request);
					void this.replyToUnauthorizedApplicant(admission.request);
				}
			}
			return;
		}

		if (!this.seenMessages.admit(msg.id)) {
			this.debugLog(`ignored duplicate msg_id=${sanitizeLogValue(msg.id)}`);
			return;
		}

		const text = normalizeCommandText(msg.text);
		this.emit({
			kind: "inbound",
			messageId: msg.id,
			channel: msg.type,
			senderLabel: msg.type === "group" ? msg.groupOpenId ?? msg.userOpenId : msg.userOpenId,
			text,
			attachmentCount: msg.attachments.length,
			attachmentKinds: msg.attachments.map(classifyAttachment),
			fake: msg.fake === true,
			at: msg.receivedAt,
		});
		if (text.startsWith("/")) {
			if (msg.attachments.length > 0) {
				void this.replyToQQ(msg, "## 命令未执行\n\n管理命令不能与附件同时发送。请单独发送命令，附件没有被下载。");
				return;
			}
			this.handleCommand(msg, text);
			return;
		}
		this.enqueuePrompt(msg);
	}

	private enqueuePrompt(msg: QQInboundMessage): void {
		const accepted = this.queue.enqueue(msg);
		if (!accepted) {
			this.lastError = "queue full; message dropped";
			this.emit({ kind: "error", messageId: msg.id, stage: "queue", message: this.lastError, at: Date.now() });
			this.emitRuntimeState();
			this.debugLog(this.lastError);
			if (this.config.sendBusyNotice && !msg.fake) {
				void this.sendBusyNotice(msg);
			}
			return;
		}
		this.emit({ kind: "queued", messageId: msg.id, queueSize: this.queue.size, at: Date.now() });
		this.emitRuntimeState();
		this.schedulePump();
	}

	// --- QQ command control plane -----------------------------------------

	private handleCommand(msg: QQInboundMessage, text: string): void {
		void this.commands.handle(msg, text).catch((error) => {
			this.debugLog(`command reply failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private hasActiveOrQueuedConversation(msg: QQInboundMessage): boolean {
		return (this.running && !!this.activeTarget && sameConversation(msg, this.activeTarget)) || this.queue.hasConversation(msg);
	}

	private async stopConversation(msg: QQInboundMessage): Promise<{ removed: number; wasRunning: boolean }> {
		const session = this.conversations?.peek(msg);
		const removed = this.queue.removeConversation(msg);
		const wasRunning = session?.isStreaming() === true || (this.running && !!this.activeTarget && sameConversation(msg, this.activeTarget));
		if (wasRunning) this.activeRunAbort?.abort(new Error("QQ task stopped"));
		await session?.abort();
		return { removed, wasRunning };
	}

	private commandKeyboard(
		msg: QQInboundMessage,
		rows: Parameters<RemoteCommandController["keyboard"]>[1],
	): QQKeyboard | undefined {
		return this.commands.keyboard(msg, rows);
	}

	private async replyToQQ(msg: QQInboundMessage, text: string, keyboard?: QQKeyboard): Promise<void> {
		const target: QQReplyTarget = {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
			createdAt: Date.now(),
		};
		await this.deliverReply(target, text, msg.fake === true, keyboard);
	}

	/** Simulate an inbound private message for local testing (/qqbot-fake). */
	simulateInbound(text: string): void {
		const msg: QQInboundMessage = {
			id: `fake-${Date.now()}-${++this.fakeCounter}`,
			type: "private",
			text,
			userOpenId: "FAKE_USER",
			attachments: [],
			raw: { fake: true },
			receivedAt: Date.now(),
			fake: true,
		};
		this.handleInbound(msg);
	}

	// --- Queue pump ----------------------------------------------------------

	private schedulePump(): void {
		if (this.pumpScheduled) return;
		this.pumpScheduled = true;
		this.pumpTimer = setTimeout(() => {
			this.pumpTimer = undefined;
			this.pumpScheduled = false;
			this.pump();
		}, 0);
	}

	private pump(): void {
		if (this.running) return; // a QQ run is in flight
		if (!this.conversations) return;
		const msg = this.queue.dequeue();
		if (!msg) return;
		this.emitRuntimeState();
		void this.runOne(msg);
	}

	// --- Outbound ------------------------------------------------------------

	private async deliverReply(
		target: QQReplyTarget,
		text: string,
		fake: boolean,
		keyboard?: QQKeyboard,
		forcePlain = false,
	): Promise<void> {
		const full = (this.config.replyPrefix ?? "") + text;
		const replyFormat = forcePlain ? "plain" : this.config.replyFormat;
		const formatted = formatQQReply(full, replyFormat);
		const chunks = replyFormat === "plain" ? formatted.plain : formatted.markdown;

		this.lastOutbound = {
			type: target.type,
			user: target.userOpenId,
			group: target.groupOpenId,
			text: full,
			at: Date.now(),
			fake,
		};
		this.emit({
			kind: "reply_start",
			messageId: target.msgId,
			chunks: chunks.length,
			fake,
			at: Date.now(),
		});

		if (fake) {
			this.emit({
				kind: "reply_end",
				messageId: target.msgId,
				ok: true,
				sentChunks: chunks.length,
				at: Date.now(),
			});
			this.debugLog(`[fake] would send ${chunks.length} ${replyFormat === "plain" ? "plain" : "markdown"} chunk(s) to ${target.type}`);
			return;
		}
		if (!this.api) {
			const detail = "QQ API is not ready";
			this.emit({
				kind: "reply_end",
				messageId: target.msgId,
				ok: false,
				sentChunks: 0,
				error: detail,
				at: Date.now(),
			});
			return;
		}

		try {
			const result = await deliverFormattedReply(this.api, this.replyBudget(target.msgId), {
				target,
				formatted,
				useMarkdown: replyFormat !== "plain",
				forceSingleChunk: forcePlain,
				keyboard,
				canFallback: (error) => error instanceof QQApiError && canFallbackFromMarkdown(error),
				onFallback: (error) => {
					const apiError = error as QQApiError;
					this.debugLog(`markdown rejected; falling back to plain text (status ${apiError.status}${apiError.code != null ? `, code ${apiError.code}` : ""})`);
				},
			});
			this.debugLog(`reply delivery=${result.delivery} chunks=${result.sentChunks}${keyboard ? ` keyboardRows=${keyboard.content.rows.length}` : ""}`);
			this.emit({ kind: "reply_end", messageId: target.msgId, ok: true, sentChunks: result.sentChunks, at: Date.now() });
		} catch (error) {
			const deliveryError = error instanceof ReplyDeliveryError ? error : new ReplyDeliveryError(0, error);
			const detail = deliveryError.cause instanceof QQApiError ? deliveryError.cause.message : String(deliveryError.cause);
			this.lastError = `send failed: ${detail}`;
			this.emit({ kind: "reply_end", messageId: target.msgId, ok: false, sentChunks: deliveryError.sentChunks, error: detail, at: Date.now() });
			this.debugLog(this.lastError);
			this.notify(`pi-agent-qqbot send failed: ${detail}`, "error");
		}
	}

	private replyBudget(msgId: string): ReplyBudget {
		return this.replyBudgets.acquire(msgId);
	}

	private hasMediaReplyCapacity(msgId: string): boolean {
		return this.replyBudget(msgId).remaining > 1;
	}

	private reserveMediaReplySequence(msgId: string): number | undefined {
		return this.replyBudget(msgId).reserve("media", { keepFinal: true });
	}

	private async sendBusyNotice(msg: QQInboundMessage): Promise<void> {
		if (!this.api) return;
		const target: QQReplyTarget = {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
			createdAt: Date.now(),
		};
		try {
			const seq = this.replyBudget(msg.id).reserve("busy", { once: true, keepFinal: true });
			if (seq === undefined) return;
			await this.api.sendText(target, "当前消息较多，请稍后重试。需要中止排队中的任务可发送 /stop。", seq);
		} catch (err) {
			this.debugLog(`busy notice failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async sendProgressAck(msg: QQInboundMessage): Promise<void> {
		if (!this.api || msg.fake) return;
		const seq = this.replyBudget(msg.id).reserve("progress", { once: true, keepFinal: true });
		if (seq === undefined) return;
		const target: QQReplyTarget = {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
			createdAt: Date.now(),
		};
		try {
			// Plain text keeps the ack cheap and avoids spending a Markdown attempt.
			await this.api.sendText(target, "已收到，正在处理。需要中止请发送 /stop。", seq);
			this.debugLog(`progress ack sent for msg_id=${sanitizeLogValue(msg.id)} seq=${seq}`);
		} catch (err) {
			this.debugLog(`progress ack failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// --- Status / debug ------------------------------------------------------

	statusText(): string {
		const lines = [
			`pi-agent-qqbot: ${this.config.enabled ? "enabled" : "disabled"} (appId ${maskAppId(this.config.appId)}, ${this.config.sandbox ? "sandbox" : "prod"})`,
			`connection: ${this.state}${this.stateDetail ? ` (${this.stateDetail})` : ""}`,
			`queue: ${this.queue.size}`,
			`session: isolated (${this.conversations ? "ready" : "not ready"}, resident ${this.conversations?.residentCount ?? 0})`,
			`commands: ${this.config.commands.enabled ? "on (SDK control)" : "off"}`,
			`process: ${this.config.showProcess ? "on" : "off"}`,
			`progress ack: ${this.config.progress.enabled ? `on (${this.config.progress.ackAfterMs}ms)` : "off"}`,
			`reply format: ${this.config.replyFormat}`,
			`media inbound: ${this.config.media.enabled ? "on" : "off"}`,
			`media outbound: ${this.config.outboundMedia.enabled ? "on" : "off"}`,
			`active: ${this.activeTargetLabel()}`,
			`attachment: ${this.activeAttachmentStatus ?? "idle"}`,
			`outbound media: ${this.activeOutboundMediaStatus ?? "idle"}`,
			`last inbound: ${this.lastInbound ? new Date(this.lastInbound.at).toLocaleTimeString() : "none"}`,
			`last outbound: ${this.lastOutbound ? new Date(this.lastOutbound.at).toLocaleTimeString() : "none"}`,
		];
		if (this.lastAttachmentError) lines.push(`last attachment error: ${this.lastAttachmentError}`);
		if (this.lastOutboundMediaError) lines.push(`last outbound media error: ${this.lastOutboundMediaError}`);
		if (this.lastError) lines.push(`last error: ${this.lastError}`);
		return lines.join("\n");
	}

	lastSummary(): string {
		const lines: string[] = [];
		if (this.lastInbound) {
			const attachmentText = this.lastInbound.attachments.length
				? ` attachments=[${this.lastInbound.attachments.map(truncate).join(", ")}]`
				: "";
			lines.push(
				`last inbound: ${this.lastInbound.type} ${labelFor(this.lastInbound)}${this.lastInbound.authorized === false ? " (unauthorized — add to allowlist)" : ""} text="${truncate(this.lastInbound.text)}"${attachmentText}`,
			);
		}
		if (this.lastOutbound) {
			lines.push(
				`last outbound: ${this.lastOutbound.type}${this.lastOutbound.fake ? " (fake)" : ""} ${labelFor(this.lastOutbound)} text="${truncate(this.lastOutbound.text)}"`,
			);
		}
		if (this.lastAttachmentError) lines.push(`last attachment error: ${this.lastAttachmentError}`);
		if (this.lastOutboundMediaError) lines.push(`last outbound media error: ${this.lastOutboundMediaError}`);
		if (this.lastError) lines.push(`last error: ${this.lastError}`);
		return lines.length ? lines.join("\n") : "no QQBot events yet";
	}

	private activeTargetLabel(): string {
		if (!this.activeTarget) return "none";
		return this.activeTarget.type === "group"
			? `group:${this.activeTarget.groupOpenId}`
			: `private:${this.activeTarget.userOpenId}`;
	}

	private notify(text: string, level: "info" | "warning" | "error"): void {
		const ctx = this.ctx;
		if (!ctx) return;
		try {
			// hasUI/ui getters assert that the extension session is still active.
			// After /new, /resume, /fork, or /reload the cached ctx is stale and
			// must not crash the process-level QQ gateway.
			if (ctx.hasUI) ctx.ui.notify(text, level);
		} catch {
			this.ctx = undefined;
		}
	}

	private emit(event: QQTerminalEvent): void {
		try {
			this.observer?.onEvent(event);
		} catch {
			// A terminal view must never break QQ message handling.
		}
	}

	private emitRuntimeState(): void {
		this.emit({
			kind: "runtime_state",
			connection: this.state,
			detail: this.stateDetail,
			queueSize: this.queue.size,
			running: this.running,
			activeLabel: this.activeTarget
				? this.activeTarget.type === "group"
					? this.activeTarget.groupOpenId
					: this.activeTarget.userOpenId
				: undefined,
			at: Date.now(),
		});
	}

	private debugLog(msg: string): void {
		if (this.config.debug) this.notify(`[qqbot] ${msg}`, "info");
	}
}

// --- helpers ---------------------------------------------------------------

export function isAllowed(config: PiAgentQQBotConfig, msg: QQInboundMessage): boolean {
	if (msg.type === "private") {
		return (config.allowUsers ?? []).includes(msg.userOpenId);
	}
	if (msg.type === "group") {
		return (config.allowGroups ?? []).includes(msg.groupOpenId ?? "");
	}
	return false;
}

function sameConversation(msg: QQInboundMessage, target: QQReplyTarget): boolean {
	return msg.type === target.type &&
		(msg.type === "private" ? msg.userOpenId === target.userOpenId : msg.groupOpenId === target.groupOpenId);
}

function maskOpenId(value: string): string {
	if (value.length <= 12) return `${value.slice(0, 3)}…${value.slice(-3)}`;
	return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function sanitizeSummaryFilename(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "_").slice(0, 80) || "attachment";
}

function sanitizeLogValue(value: string): string {
	return value.replace(/[\r\n\t]/g, "_").slice(0, 120);
}

function canFallbackFromMarkdown(err: QQApiError): boolean {
	if (!err.requestAccepted || err.status === 401 || err.status === 403 || err.status === 429 || err.status >= 500) return false;
	return /markdown|invalid request|not allowed|不允许|不支持/i.test(err.message) || err.status === 400;
}

function truncate(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX)}…` : oneLine;
}

function labelFor(s: InboundSummary | OutboundSummary): string {
	return s.type === "group" ? `group=${s.group}` : `user=${s.user}`;
}
