import { basename, extname, isAbsolute, resolve } from "node:path";

import { QQApi, QQApiError } from "../qq/api.ts";
import { LocalFileError, openVerifiedLocalFile, type OpenedLocalFile } from "../platform/opened-file-identity.ts";
import type {
	PiAgentQQBotConfig,
	QQInboundMessage,
	QQMediaKind,
	QQOutboundDeliveryRecord,
	QQReplyTarget,
} from "../../application/ports.ts";

export type QQOutboundKind = "auto" | "image" | "file";

const QQ_MEDIA_HARD_LIMIT_BYTES = 200 * 1024 * 1024;

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
}

export class QQOutboundMediaError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

/** Per-agent-run delivery context. QQ's passive reply budget is the only per-turn count limit. */
export class QQOutboundDeliveryContext {
	private readonly recordsValue: QQOutboundDeliveryRecord[] = [];
	private closed = false;

	constructor(private readonly options: QQOutboundDeliveryOptions) {}

	close(): void {
		this.closed = true;
	}

	async sendLocalFile(inputPath: string, requestedKind: QQOutboundKind = "auto"): Promise<QQOutboundDeliveryRecord> {
		let opened: OpenedLocalFile | undefined;
		let filename = safeFilename(inputPath);
		let bytes = 0;
		let mediaKind: QQMediaKind = requestedKind === "image" ? "image" : "file";
		let phase: "validation" | "upload" | "send" = "validation";
		try {
			this.assertAvailable();
			this.assertAuthorized();
			if (this.options.fake) throw new QQOutboundMediaError("fake_mode", "模拟消息不会读取或上传本地文件");
			if (!this.options.hasMessageSequenceCapacity()) {
				throw new QQOutboundMediaError("reply_budget_exhausted", "QQ 被动回复配额不足，无法发送媒体");
			}

			opened = await openVerifiedLocalFile({
				candidate: normalizeInputPath(inputPath, this.options.cwd),
				deniedRoots: this.options.config.outboundMedia.deniedRoots.map((root) => normalizeInputPath(root, this.options.cwd)),
				...(this.options.signal ? { signal: this.options.signal } : {}),
			});
			filename = safeFilename(opened.path);
			bytes = opened.size;
			if (bytes > QQ_MEDIA_HARD_LIMIT_BYTES) {
				throw new QQOutboundMediaError("file_too_large", `文件超过 QQ ${formatBytes(QQ_MEDIA_HARD_LIMIT_BYTES)} 硬限制`);
			}

			const detectedKind = detectMediaKind(await opened.readRange(0, 32));
			if (requestedKind === "image" && detectedKind !== "image") {
				throw new QQOutboundMediaError("unsupported_media_type", "图片必须是有效的 PNG 或 JPEG 文件");
			}
			mediaKind = requestedKind === "file" ? "file" : detectedKind;
			this.assertPolicyAllows(filename, mediaKind);
			const originalKind = mediaKind;
			mediaKind = downgradeForQQSoftLimit(mediaKind, bytes);
			if (mediaKind !== originalKind) this.assertPolicyAllows(filename, mediaKind);

			if (!this.options.api) throw new QQOutboundMediaError("qq_api_unavailable", "QQ API 尚未就绪");
			this.assertAvailable();
			phase = "upload";
			const uploaded = await this.options.api.uploadLocalFile(
				this.options.target,
				fileTypeFor(mediaKind),
				opened,
				filename,
				this.options.signal,
			);
			const msgSeq = this.options.reserveMessageSequence();
			if (msgSeq === undefined) throw new QQOutboundMediaError("reply_budget_exhausted", "QQ 被动回复配额不足，已取消媒体发送");
			phase = "send";
			try {
				await this.options.api.sendMedia(this.options.target, uploaded.fileInfo, msgSeq, this.options.signal);
			} catch (error) {
				if (error instanceof QQApiError && !error.requestAccepted) {
					const record = this.failureRecord(filename, mediaKind, bytes, "media_send_unknown", "网络中断，无法确认 QQ 是否收到文件", "unknown");
					throw new QQOutboundMediaError(record.errorCode ?? "media_send_unknown", record.note ?? "发送结果未知");
				}
				throw error;
			}

			const record: QQOutboundDeliveryRecord = { filename, kind: mediaKind, bytes, status: "sent" };
			this.recordsValue.push(record);
			return record;
		} catch (error) {
			if (error instanceof LocalFileError) {
				const mapped = new QQOutboundMediaError(error.code, localFileMessage(error.code));
				this.failureRecord(filename, mediaKind, bytes, mapped.code, mapped.message);
				throw mapped;
			}
			if (error instanceof QQOutboundMediaError) {
				if (!this.recordsValue.some((record) => record.filename === filename && record.errorCode === error.code)) {
					this.failureRecord(filename, mediaKind, bytes, error.code, error.message);
				}
				throw error;
			}
			const normalized = normalizeQQError(error, phase);
			this.failureRecord(filename, mediaKind, bytes, normalized.code, normalized.message);
			throw new QQOutboundMediaError(normalized.code, normalized.message);
		} finally {
			await opened?.close().catch(() => undefined);
		}
	}

	private assertAvailable(): void {
		if (this.closed || this.options.signal?.aborted) {
			throw new QQOutboundMediaError("delivery_context_closed", "当前 QQ 回合已经结束或被停止");
		}
	}

	private assertAuthorized(): void {
		if (!this.options.config.outboundMedia.enabled) throw new QQOutboundMediaError("outbound_disabled", "电脑文件发送功能尚未启用");
		if (this.options.message.type !== "private" || this.options.message.userOpenId !== this.options.config.ownerOpenId) {
			throw new QQOutboundMediaError("outbound_not_authorized", "文件只能发送到已配置的 QQ 所有者私聊");
		}
	}

	private assertPolicyAllows(filename: string, kind: QQMediaKind): void {
		const policy = this.options.config.outboundMedia;
		if (policy.deniedKinds.includes(kind)) throw new QQOutboundMediaError("outbound_kind_denied", `已禁止发送 ${kind} 类型文件`);
		const extension = extname(filename).toLowerCase();
		if (extension && policy.deniedExtensions.includes(extension)) {
			throw new QQOutboundMediaError("outbound_extension_denied", `已禁止发送 ${extension} 文件`);
		}
	}

	private failureRecord(
		filename: string,
		kind: QQMediaKind,
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
}

export function normalizeInputPath(input: string, cwd: string): string {
	let value = input.trim();
	if (value.startsWith("@") && value.length > 1) value = value.slice(1);
	if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new QQOutboundMediaError("path_invalid", "本地文件路径无效");
	return resolve(isAbsolute(value) ? value : resolve(cwd, value));
}

function detectMediaKind(header: Buffer): QQMediaKind {
	if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image";
	if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image";
	if (header.subarray(4, 8).toString("ascii") === "ftyp") return "video";
	if (header.subarray(0, 4).toString("ascii") === "OggS" || header.subarray(0, 4).toString("ascii") === "RIFF" || header.subarray(0, 3).toString("ascii") === "ID3") return "voice";
	return "file";
}

function downgradeForQQSoftLimit(kind: QQMediaKind, bytes: number): QQMediaKind {
	const softLimit = kind === "video" ? 30 * 1024 * 1024 : kind === "file" ? QQ_MEDIA_HARD_LIMIT_BYTES : 20 * 1024 * 1024;
	return bytes > softLimit ? "file" : kind;
}

function fileTypeFor(kind: QQMediaKind): 1 | 2 | 3 | 4 {
	return kind === "image" ? 1 : kind === "video" ? 2 : kind === "voice" ? 3 : 4;
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
	return basename(path.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) || "file";
}

function normalizeQQError(error: unknown, phase: "validation" | "upload" | "send"): { code: string; message: string } {
	if (error instanceof QQApiError) {
		if (error.code === 850019) return { code: "unsupported_media_type", message: "QQ 不支持该富媒体文件格式" };
		if (error.code === 850031) return { code: "file_too_large", message: "文件超过 QQ 平台大小限制" };
		if (error.status === 429 || error.code === 22009) return { code: "reply_budget_exhausted", message: "QQ 回复频率或配额已达上限" };
		return { code: phase === "send" ? "media_send_failed" : "media_upload_failed", message: sanitizeError(error.message) };
	}
	return { code: phase === "send" ? "media_send_failed" : "media_upload_failed", message: sanitizeError(error instanceof Error ? error.message : String(error)) };
}

function sanitizeError(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "QQ 富媒体处理失败";
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}
