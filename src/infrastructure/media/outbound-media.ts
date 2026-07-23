import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { QQApi, QQApiError } from "../qq/api";
import {
	LocalFileError,
	openVerifiedLocalFile,
	type OpenedLocalFile,
} from "../platform/opened-file-identity";
import type {
	PiAgentQQBotConfig,
	QQInboundMessage,
	QQOutboundDeliveryRecord,
	QQReplyTarget,
} from "../../application/ports";

export type QQOutboundKind = "auto" | "image" | "file";

export interface QQOutboundEvent {
	stage: "start" | "uploaded" | "sent" | "failed";
	record: QQOutboundDeliveryRecord;
}

export interface QQOutboundDeliveryOptions {
	config: PiAgentQQBotConfig;
	cwd: string;
	message: QQInboundMessage;
	target: QQReplyTarget;
	api?: QQApi | undefined;
	signal?: AbortSignal | undefined;
	fake: boolean;
	hasMessageSequenceCapacity(): boolean;
	reserveMessageSequence(): number | undefined;
	onEvent?(event: QQOutboundEvent): void;
}

export class QQOutboundMediaError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** Per-agent-run delivery context. It is closed before another QQ target can be bound. */
export class QQOutboundDeliveryContext {
	private readonly options: QQOutboundDeliveryOptions;
	private readonly recordsValue: QQOutboundDeliveryRecord[] = [];
	private sentFiles = 0;
	private totalBytes = 0;
	private closed = false;

	constructor(options: QQOutboundDeliveryOptions) {
		this.options = options;
	}

	get records(): readonly QQOutboundDeliveryRecord[] {
		return this.recordsValue;
	}

	close(): void {
		this.closed = true;
	}

	async sendLocalFile(inputPath: string, requestedKind: QQOutboundKind = "auto"): Promise<QQOutboundDeliveryRecord> {
		let opened: OpenedLocalFile | undefined;
		let filename = safeFilename(inputPath);
		let bytes = 0;
		let mediaKind: "image" | "file" = requestedKind === "image" ? "image" : "file";
		let phase: "validation" | "upload" | "send" = "validation";
		try {
			this.assertAvailable();
			this.assertAuthorized();
			if (this.sentFiles >= this.options.config.outboundMedia.maxFilesPerTurn) {
				throw new QQOutboundMediaError("turn_file_limit", "本回合可发送的文件数量已达到上限");
			}
			if (this.options.fake) throw new QQOutboundMediaError("fake_mode", "模拟消息不会读取或上传本地文件");
			if (!this.options.hasMessageSequenceCapacity()) {
				throw new QQOutboundMediaError("reply_budget_exhausted", "QQ 被动回复配额不足，无法发送媒体");
			}

			const candidate = normalizeInputPath(inputPath, this.options.cwd);
			opened = await openVerifiedLocalFile({
				candidate,
				deniedRoots: this.options.config.outboundMedia.deniedRoots.map((root) => normalizeInputPath(root, this.options.cwd)),
				...(this.options.signal ? { signal: this.options.signal } : {}),
			});
			filename = safeFilename(opened.path);
			bytes = opened.size;
			const absoluteMaxBytes = Math.max(
				this.options.config.outboundMedia.maxImageBytes,
				this.options.config.outboundMedia.maxFileBytes,
			);
			if (bytes > absoluteMaxBytes) throw new QQOutboundMediaError("file_too_large", `文件超过 ${formatBytes(absoluteMaxBytes)} 限制`);
			const fileBytes = await opened.read();
			const detectedImage = detectImage(fileBytes.subarray(0, 16));
			if (requestedKind === "image" && !detectedImage) {
				throw new QQOutboundMediaError("unsupported_media_type", "图片必须是有效的 PNG 或 JPEG 文件");
			}
			mediaKind = requestedKind === "file" ? "file" : detectedImage ? "image" : "file";
			if (mediaKind === "image" && !this.options.config.outboundMedia.images) {
				throw new QQOutboundMediaError("outbound_images_disabled", "本地图片发送已关闭");
			}
			if (mediaKind === "file" && !this.options.config.outboundMedia.files) {
				throw new QQOutboundMediaError("outbound_files_disabled", "本地文件发送已关闭");
			}
			const maxBytes = mediaKind === "image"
				? this.options.config.outboundMedia.maxImageBytes
				: this.options.config.outboundMedia.maxFileBytes;
			if (bytes > maxBytes) throw new QQOutboundMediaError("file_too_large", `文件超过 ${formatBytes(maxBytes)} 限制`);
			if (this.totalBytes + bytes > this.options.config.outboundMedia.maxTotalBytes) {
				throw new QQOutboundMediaError("turn_total_limit", "本回合发送文件的累计大小超过限制");
			}

			this.emit("start", { filename, kind: mediaKind, bytes, status: "failed" });
			if (!this.options.api) throw new QQOutboundMediaError("qq_api_unavailable", "QQ API 尚未就绪");
			const fileData = fileBytes.toString("base64");
			this.assertAvailable();
			phase = "upload";
			const uploaded = await this.options.api.uploadMedia(
				this.options.target,
				mediaKind === "image" ? 1 : 4,
				fileData,
				this.options.signal,
				this.options.config.outboundMedia.uploadTimeoutMs,
			);
			this.emit("uploaded", { filename, kind: mediaKind, bytes, status: "failed" });

			const msgSeq = this.options.reserveMessageSequence();
			if (msgSeq === undefined) throw new QQOutboundMediaError("reply_budget_exhausted", "QQ 被动回复配额不足，已取消媒体发送");
			phase = "send";
			try {
				await this.options.api.sendMedia(this.options.target, uploaded.fileInfo, msgSeq, this.options.signal);
			} catch (err) {
				if (err instanceof QQApiError && !err.requestAccepted) {
					const record = this.failureRecord(filename, mediaKind, bytes, "media_send_unknown", "网络中断，无法确认 QQ 是否收到文件", "unknown");
					this.emit("failed", record);
					throw new QQOutboundMediaError(record.errorCode ?? "media_send_unknown", record.note ?? "发送结果未知");
				}
				throw err;
			}

			const record: QQOutboundDeliveryRecord = { filename, kind: mediaKind, bytes, status: "sent" };
			this.recordsValue.push(record);
			this.sentFiles++;
			this.totalBytes += bytes;
			this.emit("sent", record);
			return record;
		} catch (err) {
			if (err instanceof LocalFileError) {
				const mapped = new QQOutboundMediaError(err.code, localFileMessage(err.code));
				const record = this.failureRecord(filename, mediaKind, bytes, mapped.code, mapped.message);
				this.emit("failed", record);
				throw mapped;
			}
			if (err instanceof QQOutboundMediaError) {
				if (!this.recordsValue.some((record) => record.filename === filename && record.errorCode === err.code)) {
					const record = this.failureRecord(filename, mediaKind, bytes, err.code, err.message);
					this.emit("failed", record);
				}
				throw err;
			}
			const normalized = normalizeQQError(err, phase);
			const record = this.failureRecord(filename, mediaKind, bytes, normalized.code, normalized.message);
			this.emit("failed", record);
			throw new QQOutboundMediaError(normalized.code, normalized.message);
		} finally {
			await opened?.close().catch(() => undefined);
		}
	}

	private assertAvailable(): void {
		if (this.closed) throw new QQOutboundMediaError("delivery_context_closed", "当前 QQ 回合已经结束或被停止");
		if (this.options.signal?.aborted) throw new QQOutboundMediaError("delivery_context_closed", "当前 QQ 回合已经被停止");
	}

	private assertAuthorized(): void {
		const policy = this.options.config.outboundMedia;
		if (!policy.enabled) throw new QQOutboundMediaError("outbound_disabled", "电脑文件发送功能尚未启用");
		if (this.options.message.type === "private" && !policy.allowPrivate) {
			throw new QQOutboundMediaError("outbound_private_disabled", "私聊文件发送已关闭");
		}
		if (this.options.message.type === "group" && !policy.allowGroups) {
			throw new QQOutboundMediaError("outbound_group_disabled", "群聊文件发送已关闭");
		}
		if (policy.adminsOnly && this.options.message.userOpenId !== this.options.config.allowUsers?.[0]) {
			throw new QQOutboundMediaError("outbound_not_authorized", "只有显式配置的 QQ 管理员可以发送电脑文件");
		}
	}

	private failureRecord(
		filename: string,
		kind: "image" | "file",
		bytes: number,
		errorCode: string,
		note: string,
		status: "failed" | "unknown" = "failed",
	): QQOutboundDeliveryRecord {
		const existing = this.recordsValue.find((record) => record.filename === filename && record.errorCode === errorCode);
		if (existing) return existing;
		const record: QQOutboundDeliveryRecord = { filename, kind, bytes, status, errorCode, note };
		this.recordsValue.push(record);
		return record;
	}

	private emit(stage: QQOutboundEvent["stage"], record: QQOutboundDeliveryRecord): void {
		try {
			this.options.onEvent?.({ stage, record });
		} catch {
			// Observation must never change delivery behavior.
		}
	}
}

export async function resolveUnblockedLocalFile(input: string, cwd: string, deniedRoots: string[]): Promise<string> {
	const normalized = normalizeInputPath(input, cwd);
	let candidate: string;
	try {
		candidate = await realpath(normalized);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new QQOutboundMediaError("file_not_found", "本地文件不存在");
		throw new QQOutboundMediaError("path_invalid", "无法解析本地文件路径");
	}
	const roots: string[] = [];
	for (const rootInput of deniedRoots) {
		try {
			roots.push(await realpath(normalizeInputPath(rootInput, cwd)));
		} catch {
			// A missing denied root cannot contain the already-resolved candidate.
		}
	}
	if (roots.some((root) => isWithinRoot(candidate, root))) {
		throw new QQOutboundMediaError("path_denied", "文件位于禁止发送的目录中");
	}
	return candidate;
}

export function normalizeInputPath(input: string, cwd: string): string {
	let value = input.trim();
	if (value.startsWith("@") && value.length > 1) value = value.slice(1);
	if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new QQOutboundMediaError("path_invalid", "本地文件路径无效");
	}
	return resolve(isAbsolute(value) ? value : resolve(cwd, value));
}

function isWithinRoot(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function detectImage(header: Buffer): "png" | "jpeg" | undefined {
	if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
	if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "jpeg";
	return undefined;
}

function localFileMessage(code: LocalFileError["code"]): string {
	const messages: Record<LocalFileError["code"], string> = {
		file_not_found: "本地文件不存在",
		path_invalid: "本地文件路径无效",
		path_denied: "文件位于禁止发送的目录中",
		not_regular_file: "目标不是普通文件",
		hardlink_not_allowed: "为避免越权读取，不允许发送硬链接文件",
		empty_file: "QQ 富媒体不支持空文件",
		file_changed: "文件在读取过程中发生变化，请重试",
		operation_aborted: "当前 QQ 回合已经被停止",
	};
	return messages[code];
}

function safeFilename(path: string): string {
	return basename(path.replaceAll("\\", "/"))
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.slice(0, 120) || "file";
}

function normalizeQQError(err: unknown, phase: "validation" | "upload" | "send"): { code: string; message: string } {
	if (err instanceof QQApiError) {
		if (err.code === 850019) return { code: "unsupported_media_type", message: "QQ 不支持该富媒体文件格式" };
		if (err.status === 429 || err.code === 22009) return { code: "reply_budget_exhausted", message: "QQ 回复频率或配额已达上限" };
		return { code: phase === "send" ? "media_send_failed" : "media_upload_failed", message: sanitizeError(err.message) };
	}
	return { code: phase === "send" ? "media_send_failed" : "media_upload_failed", message: sanitizeError(err instanceof Error ? err.message : String(err)) };
}

function sanitizeError(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "QQ 富媒体处理失败";
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}
