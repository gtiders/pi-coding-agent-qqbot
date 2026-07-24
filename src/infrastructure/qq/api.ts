/**
 * QQ Bot outbound passive-reply API for plain text and native Markdown.
 * QQ currently permits four passive replies for each originating C2C message.
 */

import { createHash } from "node:crypto";

import type { QQAuth } from "./auth";
import type { QQKeyboard, QQMediaUploadResult, QQReplyTarget } from "../../application/ports";
import type { OpenedLocalFile } from "../platform/opened-file-identity.ts";

const PROD_BASE = "https://api.sgroup.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";
const HASH_CHUNK_BYTES = 5 * 1024 * 1024;
const MD5_10M_BYTES = 10_002_432;

interface UploadPart {
	index: number;
	presignedUrl: string;
	blockSize: number;
}

interface UploadPrepareResult {
	uploadId: string;
	blockSize: number;
	parts: UploadPart[];
	concurrency: number;
	retryTimeoutMs: number;
	retryDelayMs: number;
}

export interface QQApiOptions {
	sandbox: boolean;
}

export class QQApiError extends Error {
	readonly status: number;
	readonly code: number | undefined;
	readonly requestAccepted: boolean;
	constructor(message: string, status: number, code?: number, requestAccepted = false) {
		super(message);
		this.status = status;
		this.code = code;
		this.requestAccepted = requestAccepted;
	}
}

export class QQApi {
	private readonly auth: QQAuth;
	private readonly base: string;

	constructor(auth: QQAuth, opts: QQApiOptions) {
		this.auth = auth;
		this.base = opts.sandbox ? SANDBOX_BASE : PROD_BASE;
	}

	async sendText(target: QQReplyTarget, content: string, msgSeq: number): Promise<void> {
		await this.send(target, { content, msg_type: 0, msg_id: target.msgId, msg_seq: msgSeq });
	}

	async sendMarkdown(
		target: QQReplyTarget,
		content: string,
		msgSeq: number,
		keyboard?: QQKeyboard,
	): Promise<void> {
		await this.send(target, {
			markdown: { content },
			msg_type: 2,
			msg_id: target.msgId,
			msg_seq: msgSeq,
			...(keyboard ? { keyboard } : {}),
			// QQ documents group content as required even for Markdown.
			...(target.type === "group" ? { content: " " } : {}),
		});
	}

	/** Upload a verified local file through QQ's official prepare/chunk/finalize protocol. */
	async uploadLocalFile(
		target: QQReplyTarget,
		fileType: 1 | 2 | 3 | 4,
		file: OpenedLocalFile,
		filename: string,
		signal?: AbortSignal,
	): Promise<QQMediaUploadResult> {
		const hashes = await hashFile(file);
		const prepare = await this.prepareUpload(target, fileType, file.size, filename, hashes, signal);
		await runWorkers(prepare.parts, prepare.concurrency, async (part) => {
			const offset = part.index * prepare.blockSize;
			const bytes = await file.readRange(offset, part.blockSize);
			if (bytes.length !== part.blockSize && offset + bytes.length !== file.size) {
				throw new QQApiError(`media upload part ${part.index} has an unexpected size`, 0);
			}
			await putPart(part, bytes, prepare.retryTimeoutMs, prepare.retryDelayMs, signal);
			await this.finishPart(target, prepare.uploadId, part.index, bytes.length, createHash("md5").update(bytes).digest("hex"), signal);
		});
		await file.verifyUnchanged();

		const body = await this.postJson(this.mediaPath(target, "files"), {
			file_type: fileType,
			file_name: filename,
			upload_id: prepare.uploadId,
			srv_send_msg: false,
		}, signal, 10_000, "media upload finalize");
		if (typeof body.file_info !== "string" || !body.file_info) {
			throw new QQApiError("media upload finalize response missing file_info", 502, undefined, true);
		}
		return {
			fileInfo: body.file_info,
			...(typeof body.file_uuid === "string" ? { fileUuid: body.file_uuid } : {}),
			ttl: typeof body.ttl === "number" && Number.isFinite(body.ttl) ? body.ttl : 0,
		};
	}

	private async prepareUpload(
		target: QQReplyTarget,
		fileType: 1 | 2 | 3 | 4,
		fileSize: number,
		filename: string,
		hashes: { md5: string; sha1: string; md5_10m: string },
		signal?: AbortSignal,
	): Promise<UploadPrepareResult> {
		const body = await this.postJson(this.mediaPath(target, "upload_prepare"), {
			file_type: fileType,
			file_size: String(fileSize),
			file_name: filename,
			...hashes,
		}, signal, 10_000, "media upload prepare");
		const uploadId = requiredString(body.upload_id, "upload_id");
		const blockSize = positiveInteger(body.block_size, "block_size");
		if (!Array.isArray(body.parts) || body.parts.length === 0) throw new QQApiError("media upload prepare response missing parts", 502, undefined, true);
		const parts = body.parts.map((value, position) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new QQApiError("media upload prepare returned an invalid part", 502, undefined, true);
			const part = value as Record<string, unknown>;
			return {
				index: nonNegativeInteger(part.index, `parts[${position}].index`),
				presignedUrl: requiredString(part.presigned_url, `parts[${position}].presigned_url`),
				blockSize: positiveInteger(part.block_size, `parts[${position}].block_size`),
			};
		});
		const expectedParts = Math.ceil(fileSize / blockSize);
		const indices = new Set(parts.map((part) => part.index));
		if (parts.length !== expectedParts || indices.size !== expectedParts || !Array.from({ length: expectedParts }, (_, index) => indices.has(index)).every(Boolean)) {
			throw new QQApiError("media upload prepare response does not cover the file", 502, undefined, true);
		}
		const uploadConfig = body.upload_config && typeof body.upload_config === "object" && !Array.isArray(body.upload_config)
			? body.upload_config as Record<string, unknown>
			: {};
		return {
			uploadId,
			blockSize,
			parts,
			concurrency: positiveIntegerOr(uploadConfig.concurrency, 1),
			retryTimeoutMs: positiveIntegerOr(uploadConfig.retry_timeout, 300) * 1000,
			retryDelayMs: positiveIntegerOr(uploadConfig.retry_delay, 1) * 1000,
		};
	}

	private async finishPart(
		target: QQReplyTarget,
		uploadId: string,
		partIndex: number,
		blockSize: number,
		md5: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.postJson(this.mediaPath(target, "upload_part_finish"), {
			upload_id: uploadId,
			part_index: partIndex,
			block_size: String(blockSize),
			md5,
		}, signal, 10_000, "media upload part finish");
	}

	private mediaPath(target: QQReplyTarget, operation: "files" | "upload_prepare" | "upload_part_finish"): string {
		return target.type === "private"
			? `/v2/users/${encodeURIComponent(target.userOpenId)}/${operation}`
			: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/${operation}`;
	}

	/** Send previously uploaded media as a passive reply to the current QQ message. */
	async sendMedia(target: QQReplyTarget, fileInfo: string, msgSeq: number, signal?: AbortSignal): Promise<void> {
		await this.send(target, {
			msg_type: 7,
			media: { file_info: fileInfo },
			msg_id: target.msgId,
			msg_seq: msgSeq,
			...(target.type === "group" ? { content: " " } : {}),
		}, signal);
	}

	private async send(target: QQReplyTarget, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		const path =
			target.type === "private"
				? `/v2/users/${encodeURIComponent(target.userOpenId)}/messages`
				: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/messages`;
		await this.postJson(path, payload, signal, 10_000, "send");
	}

	private async postJson(
		path: string,
		payload: Record<string, unknown>,
		signal: AbortSignal | undefined,
		timeoutMs: number,
		operation: string,
	): Promise<Record<string, unknown>> {
		const token = await this.auth.getToken();
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `QQBot ${token}`,
				},
				body: JSON.stringify(payload),
				signal: requestSignal,
			});
		} catch (err) {
			throw new QQApiError(
				`${operation} request failed: ${err instanceof Error ? err.message : String(err)}`,
				0,
			);
		}

		let body: Record<string, unknown> = {};
		try {
			body = (await res.json()) as Record<string, unknown>;
		} catch {
			// Successful sends may have no useful body; errors are still reported below.
		}
		if (res.ok) return body;

		const code = typeof body.code === "number" ? body.code : undefined;
		const message = typeof body.message === "string" ? body.message : "";
		throw new QQApiError(
			`${operation} failed (status ${res.status}${code != null ? `, code ${code}` : ""})${message ? `: ${message}` : ""}`,
			res.status,
			code,
			true,
		);
	}
}

async function hashFile(file: OpenedLocalFile): Promise<{ md5: string; sha1: string; md5_10m: string }> {
	const md5 = createHash("md5");
	const sha1 = createHash("sha1");
	const md5_10m = createHash("md5");
	let firstRemaining = MD5_10M_BYTES;
	for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
		const expected = Math.min(HASH_CHUNK_BYTES, file.size - offset);
		const bytes = await file.readRange(offset, expected);
		if (bytes.length !== expected) throw new QQApiError("local file ended while hashing", 0);
		md5.update(bytes);
		sha1.update(bytes);
		if (firstRemaining > 0) {
			const slice = bytes.subarray(0, Math.min(firstRemaining, bytes.length));
			md5_10m.update(slice);
			firstRemaining -= slice.length;
		}
	}
	return { md5: md5.digest("hex"), sha1: sha1.digest("hex"), md5_10m: md5_10m.digest("hex") };
}

async function putPart(part: UploadPart, bytes: Buffer, timeoutMs: number, retryDelayMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const remaining = Math.max(1, deadline - Date.now());
		const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining);
		try {
			const response = await fetch(part.presignedUrl, { method: "PUT", body: new Uint8Array(bytes), signal: requestSignal });
			if (response.ok) return;
			await response.body?.cancel().catch(() => undefined);
			lastError = new Error(`HTTP ${response.status}`);
		} catch (error) {
			if (signal?.aborted) throw error;
			lastError = error;
		}
		if (Date.now() + retryDelayMs >= deadline) break;
		await delay(retryDelayMs, signal);
	}
	throw new QQApiError(`media upload part ${part.index} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`, 0);
}

async function runWorkers<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
	let cursor = 0;
	let firstError: unknown;
	const count = Math.min(items.length, Math.max(1, Math.trunc(concurrency)));
	await Promise.all(Array.from({ length: count }, async () => {
		while (firstError === undefined && cursor < items.length) {
			const item = items[cursor++];
			if (item === undefined) continue;
			try {
				await worker(item);
			} catch (error) {
				firstError = error;
			}
		}
	}));
	if (firstError !== undefined) throw firstError;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) throw new QQApiError(`media upload prepare response missing ${field}`, 502, undefined, true);
	return value;
}

function positiveInteger(value: unknown, field: string): number {
	const parsed = typeof value === "string" ? Number(value) : value;
	if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new QQApiError(`media upload prepare response has invalid ${field}`, 502, undefined, true);
	}
	return parsed;
}

function nonNegativeInteger(value: unknown, field: string): number {
	const parsed = typeof value === "string" ? Number(value) : value;
	if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
		throw new QQApiError(`media upload prepare response has invalid ${field}`, 502, undefined, true);
	}
	return parsed;
}

function positiveIntegerOr(value: unknown, fallback: number): number {
	const parsed = typeof value === "string" ? Number(value) : value;
	return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
