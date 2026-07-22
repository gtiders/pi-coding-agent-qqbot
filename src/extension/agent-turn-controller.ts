import { runAgentTurnWithCleanup } from "../application/run-agent-turn";
import type { PiAgentQQBotConfig, PreparedAttachment, QQInboundMessage, QQKeyboard, QQOutboundDeliveryRecord, QQReplyTarget, QQTerminalEvent } from "../application/ports";
import { AttachmentPipeline } from "../infrastructure/media/attachment-pipeline";
import { QQOutboundDeliveryContext } from "../infrastructure/media/outbound-media";
import type { QQApi } from "../infrastructure/qq/api";
import type { QQAgentRunEvent, QQAgentSession, QQToolCall } from "../infrastructure/pi/agent-session";
import { formatUserFacingAgentError } from "../presentation/qq/user-facing-errors";

const MAX_TRANSCRIPT_LINES = 6;

export interface AgentTurnHost {
	config(): PiAgentQQBotConfig;
	api(): QQApi | undefined;
	cwd(): string;
	getConversation(message: QQInboundMessage): Promise<QQAgentSession>;
	beginRun(message: QQInboundMessage, target: QQReplyTarget, controller: AbortController): AbortSignal;
	finishRun(message: QQInboundMessage, controller: AbortController): void;
	isRunActive(messageId: string): boolean;
	reply(message: QQInboundMessage, text: string): Promise<void>;
	deliver(target: QQReplyTarget, text: string, fake: boolean, keyboard?: QQKeyboard, forcePlain?: boolean): Promise<void>;
	errorKeyboard(message: QQInboundMessage): QQKeyboard | undefined;
	sendProgress(message: QQInboundMessage): Promise<void>;
	hasMediaCapacity(messageId: string): boolean;
	reserveMediaSequence(messageId: string): number | undefined;
	setAttachmentStatus(status?: string): void;
	setAttachmentError(error: string): void;
	setOutboundStatus(status?: string): void;
	setOutboundError(error: string): void;
	recordError(messageId: string, stage: string, detail: string): void;
	emit(event: QQTerminalEvent): void;
	debug(message: string): void;
	scheduleNext(): void;
}

/** Runs one isolated QQ agent turn while the runtime owns queue and lifecycle state. */
export class AgentTurnController {
	constructor(private readonly pipeline: AttachmentPipeline, private readonly host: AgentTurnHost) {}

	async run(message: QQInboundMessage): Promise<void> {
		let session: QQAgentSession;
		try {
			session = await this.host.getConversation(message);
		} catch (error) {
			const detail = `qq session init failed: ${error instanceof Error ? error.message : String(error)}`;
			this.host.recordError(message.id, "session init", detail);
			await this.host.reply(
				message,
				`## QQ 会话不可用\n\n${formatUserFacingAgentError(error)}\n\n请稍后重试，或在主机查看 /qqbot-status。`,
			).catch(() => undefined);
			this.host.scheduleNext();
			return;
		}

		const target: QQReplyTarget = {
			type: message.type,
			userOpenId: message.userOpenId,
			groupOpenId: message.groupOpenId,
			msgId: message.id,
			createdAt: Date.now(),
		};
		const runAbort = new AbortController();
		const runSignal = this.host.beginRun(message, target, runAbort);
		let prepared: Awaited<ReturnType<AttachmentPipeline["prepare"]>> | undefined;
		let delivery: QQOutboundDeliveryContext | undefined;
		let ackTimer: ReturnType<typeof setTimeout> | undefined;
		let ackCancelled = false;
		const cancelProgress = (): void => {
			ackCancelled = true;
			if (ackTimer) clearTimeout(ackTimer);
			ackTimer = undefined;
		};
		const config = this.host.config();
		if (config.progress.enabled && !message.fake) {
			const send = () => {
				if (!ackCancelled && this.host.isRunActive(message.id)) void this.host.sendProgress(message);
			};
			if (config.progress.ackAfterMs <= 0) send();
			else ackTimer = setTimeout(send, config.progress.ackAfterMs);
		}

		await runAgentTurnWithCleanup(async () => {
		try {
			prepared = await this.pipeline.prepare(message, runSignal, {
				onStart: (index, total, kind, filename) => {
					this.host.setAttachmentStatus(`${kind} ${index}/${total}: ${filename}`);
					this.host.emit({ kind: "attachment_start", messageId: message.id, index, total, attachmentKind: kind, filename, at: Date.now() });
				},
				onProgress: (index, total, kind, filename, bytes) => {
					this.host.emit({ kind: "attachment_progress", messageId: message.id, index, total, attachmentKind: kind, filename, bytes, at: Date.now() });
				},
				onEnd: (index, total, resource, bytes) => {
					const note = resource.kind === "unsupported" ? resource.reason : resource.note;
					if (resource.status !== "ready") {
						this.host.setAttachmentError(`${resource.errorCode ?? "attachment_failed"}: ${resource.filename}${note ? ` — ${note}` : ""}`);
					}
					this.host.emit({
						kind: resource.status === "ready" ? "attachment_end" : "attachment_rejected",
						messageId: message.id,
						index,
						total,
						attachmentKind: resource.kind,
						filename: resource.filename,
						status: resource.status,
						bytes,
						note,
						at: Date.now(),
					});
				},
			});
			this.host.setAttachmentStatus(undefined);

			const readyImages = prepared.resources.filter((resource) => resource.kind === "image" && resource.status === "ready");
			if (readyImages.length && !session.supportsImages()) {
				cancelProgress();
				await this.host.deliver(
					target,
					message.text.trim()
						? "当前 QQ Agent 使用的模型不支持图片理解。我没有读取图片；请切换到支持视觉输入的模型后重试。你的文字内容也未提交，以避免产生误导性回答。"
						: "当前 QQ Agent 使用的模型不支持图片理解，因此没有运行可能产生误导的模型回合。请切换到支持视觉输入的模型后重试。",
					message.fake === true,
				);
				return;
			}
			if (!hasUsableAgentInput(message, prepared.resources)) {
				cancelProgress();
				await this.host.deliver(target, formatAttachmentFailures(prepared.resources), message.fake === true);
				return;
			}

			delivery = new QQOutboundDeliveryContext({
				config,
				cwd: this.host.cwd(),
				message,
				target,
				api: this.host.api(),
				signal: runSignal,
				fake: message.fake === true,
				hasMessageSequenceCapacity: () => this.host.hasMediaCapacity(message.id),
				reserveMessageSequence: () => this.host.reserveMediaSequence(message.id),
				onEvent: ({ stage, record }) => {
					if (stage === "start") cancelProgress();
					this.host.setOutboundStatus(stage === "sent" || stage === "failed" ? undefined : `${stage}: ${record.filename}`);
					if (stage === "failed") this.host.setOutboundError(`${record.errorCode ?? "outbound_failed"}: ${record.filename}`);
					this.host.emit({
						kind: stage === "start" ? "outbound_start" : stage === "uploaded" ? "outbound_uploaded" : stage === "sent" ? "outbound_sent" : "outbound_failed",
						messageId: message.id,
						mediaKind: record.kind,
						filename: record.filename,
						bytes: record.bytes,
						...(record.errorCode ? { errorCode: record.errorCode } : {}),
						...(record.note ? { note: record.note } : {}),
						at: Date.now(),
					});
				},
			});
			session.bindOutboundDelivery(delivery);
			const { text, tools } = await session.run(withQQReplyGuidance(prepared.prompt), prepared.images, (event) => this.forwardEvent(message.id, event));
			const answer = [formatDeliverySummary(delivery.records), text.trim()].filter(Boolean).join("\n\n");
			const body = config.showProcess ? formatWithProcess(buildTranscript(tools), answer) : answer;
			cancelProgress();
			const sentMedia = delivery.records.some((record) => record.status === "sent");
			if (body.trim()) await this.host.deliver(target, body, message.fake === true, undefined, sentMedia);
			else if (!sentMedia) {
				this.host.debug("assistant produced no text or media; sending empty-result fallback");
				await this.host.deliver(target, "本次没有生成可发送的文本或文件结果。可以换个问法，或发送 /status 查看状态。", message.fake === true);
			}
		} catch (error) {
			cancelProgress();
			if (!runSignal.aborted) {
				const detail = `qq session run failed: ${error instanceof Error ? error.message : String(error)}`;
				this.host.recordError(message.id, "agent run", detail);
				this.host.debug(detail);
				await this.host.deliver(
					target,
					`## 处理失败\n\n${formatUserFacingAgentError(error)}`,
					message.fake === true,
					this.host.errorKeyboard(message),
				).catch((sendError) => this.host.debug(`failed to deliver error reply: ${sendError instanceof Error ? sendError.message : String(sendError)}`));
			}
		}
		}, [
			() => { cancelProgress(); delivery?.close(); },
			() => { session.bindOutboundDelivery(undefined); },
			async () => { await prepared?.cleanup(); },
			() => { this.host.finishRun(message, runAbort); },
		], (error) => this.host.debug(`agent turn cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
	}

	private forwardEvent(messageId: string, event: QQAgentRunEvent): void {
		const at = Date.now();
		if (event.kind === "assistant_start") this.host.emit({ kind: "assistant_start", messageId, at });
		else if (event.kind === "assistant_delta") this.host.emit({ kind: "assistant_delta", messageId, delta: event.delta, at });
		else if (event.kind === "assistant_end") this.host.emit({ kind: "assistant_end", messageId, at });
		else if (event.kind === "tool_start") this.host.emit({ kind: "tool_start", messageId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, at });
		else this.host.emit({ kind: "tool_end", messageId, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, at });
	}
}

function hasUsableAgentInput(message: QQInboundMessage, resources: PreparedAttachment[]): boolean {
	return message.text.trim().length > 0 || resources.some((resource) => resource.status === "ready");
}

function formatAttachmentFailures(resources: PreparedAttachment[]): string {
	const failures = resources.filter((resource) => resource.status !== "ready");
	if (!failures.length) return "没有可处理的文本或附件内容。";
	return failures.map((resource) => {
		const note = resource.kind === "unsupported" ? resource.reason : resource.note ?? "处理失败";
		return `${resource.filename}：${note}（${resource.errorCode ?? "attachment_failed"}）`;
	}).join("\n");
}

function formatDeliverySummary(records: readonly QQOutboundDeliveryRecord[]): string {
	if (!records.length) return "";
	const lines = records.map((record) => {
		if (record.status === "sent") return `- 已发送：${escapeMarkdownInline(record.filename)}`;
		if (record.status === "unknown") return `- 发送结果未知：${escapeMarkdownInline(record.filename)}（${record.errorCode ?? "media_send_unknown"}）`;
		return `- 未发送：${escapeMarkdownInline(record.filename)}（${record.errorCode ?? "outbound_failed"}）`;
	});
	return `**QQ 文件交付结果**\n\n${lines.join("\n")}`;
}

function escapeMarkdownInline(value: string): string {
	return value.replace(/[\\`*_[\]~]/g, "\\$&");
}

function withQQReplyGuidance(prompt: string): string {
	return `${prompt}\n\n<qq-outbound-media-guidance>\n当用户明确要求把电脑上的本地图片或文件发送、上传或传给当前 QQ 会话时，必须调用 qq_send_local_file；在最终文本中给出本地路径、Markdown 图片或 URL 不等于发送。只有工具返回 QQ API 已确认成功后，才能说文件已发送；工具失败时必须如实说明未发送。不要调用该工具来回答仅查看、分析或告知路径的请求。\n</qq-outbound-media-guidance>\n\n<qq-reply-guidance>\n以下要求仅约束最终回答的呈现，不改变用户任务本身：请为手机 QQ 聊天界面组织最终回答，先直接给出答案或结论，删除寒暄和“好问题”等填充语；短回答不要强加标题；普通回答按“结论 → 关键点或步骤 → 必要注意事项”组织。每段只表达一个主题，段落简短；并列信息用无序列表，操作流程用有序列表，列表不要超过两层。仅对关键字使用粗体，风险或限制使用带文字标签的引用块（如“⚠️ 注意”）。避免宽表格，优先改成列表；代码仅保留必要、可复制的片段。不要添加“执行过程”章节，插件会在需要时附加执行摘要。输出 QQ 支持的简洁 Markdown，不要为了装饰堆叠标题、分割线或 Emoji。\n</qq-reply-guidance>`;
}

function argSummary(args: unknown): string {
	const values = (args ?? {}) as Record<string, unknown>;
	const selected = values.command ?? values.path ?? values.file_path ?? values.filePath ?? values.pattern ?? values.query ?? values.url;
	let summary = typeof selected === "string" ? selected : JSON.stringify(values);
	summary = (summary ?? "").replace(/\s+/g, " ").trim();
	return summary.length > 100 ? `${summary.slice(0, 100)}…` : summary;
}

function buildTranscript(tools: QQToolCall[]): string[] {
	const lines: string[] = [];
	for (const tool of tools) {
		if (lines.length >= MAX_TRANSCRIPT_LINES) break;
		lines.push(`- ${tool.isError ? "❌" : "✅"} **${tool.name}**：${argSummary(tool.args) || (tool.isError ? "执行失败" : "完成")}`);
	}
	if (tools.length > MAX_TRANSCRIPT_LINES) lines.push(`- 其余 ${tools.length - MAX_TRANSCRIPT_LINES} 项已省略`);
	return lines;
}

function formatWithProcess(transcript: string[], finalText: string): string {
	if (!transcript.length) return finalText;
	return `${finalText.trim() || "（无文本回复）"}\n\n***\n\n## 执行摘要\n\n${transcript.join("\n")}`;
}
