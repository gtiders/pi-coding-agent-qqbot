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
	request?: (sourceUrl: string, signal: AbortSignal) => Promise<{ response: IncomingMessage; url: URL }>,
): AttachmentDownloader {
	return new AttachmentDownloader({
		runtimeId: "media-test",
		messageId,
		signal: new AbortController().signal,
		...(request ? { request } : {}),
	});
}

test("preserves private-address errors instead of retrying them as network failures", async () => {
	const subject = downloader("private-address");
	try {
		await assert.rejects(
			() => subject.download("https://127.0.0.1/secret"),
			(error: unknown) => error instanceof AttachmentDownloadError && error.code === "ssrf_blocked",
		);
	} finally {
		await subject.cleanup();
	}
});

test("streams attachments without an extension-level byte limit", async () => {
	const request = async (): Promise<{ response: IncomingMessage; url: URL }> => {
		const response = Object.assign(Readable.from([Buffer.alloc(16)]), {
			headers: {},
			statusCode: 200,
		}) as IncomingMessage;
		return { response, url: new URL("https://example.com/file") };
	};
	const subject = downloader("stream-overflow", request);
	try {
		const result = await subject.download("https://example.com/file");
		assert.equal(result.bytes, 16);
	} finally {
		await subject.cleanup();
	}
});
