import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
	AttachmentDownloadError,
	AttachmentDownloader,
} from "../../../src/infrastructure/media/attachment-downloader.ts";

function downloader(
	messageId: string,
	request?: (sourceUrl: string, signal: AbortSignal, maxBytes: number) => Promise<{ response: IncomingMessage; url: URL }>,
): AttachmentDownloader {
	return new AttachmentDownloader({
		runtimeId: "media-test",
		messageId,
		timeoutMs: 2_000,
		signal: new AbortController().signal,
		...(request ? { request } : {}),
	});
}

test("preserves private-address errors instead of retrying them as network failures", async () => {
	const subject = downloader("private-address");
	try {
		await assert.rejects(
			() => subject.download("https://127.0.0.1/secret", 1024, 1024),
			(error: unknown) => error instanceof AttachmentDownloadError && error.code === "ssrf_blocked",
		);
	} finally {
		await subject.cleanup();
	}
});

test("normalizes streamed size overflow to the stable size_limit error", async () => {
	const request = async (): Promise<{ response: IncomingMessage; url: URL }> => {
		const response = Object.assign(Readable.from([Buffer.alloc(16)]), {
			headers: {},
			statusCode: 200,
		}) as IncomingMessage;
		return { response, url: new URL("https://example.com/file") };
	};
	const subject = downloader("stream-overflow", request);
	try {
		await assert.rejects(
			() => subject.download("https://example.com/file", 8, 8),
			(error: unknown) => error instanceof AttachmentDownloadError && error.code === "size_limit",
		);
	} finally {
		await subject.cleanup();
	}
});
