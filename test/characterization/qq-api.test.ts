import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { QQApi } from "../../src/infrastructure/qq/api.ts";
import type { OpenedLocalFile } from "../../src/infrastructure/platform/opened-file-identity.ts";

test("uses QQ official prepare, chunk finish, and finalize upload protocol", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ url: string; method: string; body: unknown }> = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const rawBody = init?.body;
		const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody instanceof Uint8Array ? Buffer.from(rawBody).toString("utf8") : undefined;
		requests.push({ url, method, body });
		if (url.endsWith("/upload_prepare")) {
			return Response.json({
				upload_id: "upload-1",
				block_size: "3",
				parts: [{ index: 0, presigned_url: "https://cos.example/upload/0", block_size: "3" }],
				upload_config: { concurrency: 1, retry_timeout: 5, retry_delay: 1 },
			});
		}
		if (url === "https://cos.example/upload/0") return new Response(null, { status: 200 });
		if (url.endsWith("/upload_part_finish")) return Response.json({});
		if (url.endsWith("/files")) return Response.json({ file_info: "file-info", file_uuid: "uuid", ttl: 300 });
		return Response.json({ id: "message-id" });
	}) as typeof fetch;

	try {
		const bytes = Buffer.from("abc");
		const file: OpenedLocalFile = {
			path: "C:/tmp/a.txt",
			size: bytes.length,
			async readRange(offset, length) { return bytes.subarray(offset, offset + length); },
			async verifyUnchanged() {},
			async close() {},
		};
		const target = { type: "private" as const, userOpenId: "user/id", msgId: "message-1", createdAt: Date.now() };
		const api = new QQApi({ getToken: async () => "token" } as never, { sandbox: true });
		const uploaded = await api.uploadLocalFile(target, 4, file, "a.txt");
		assert.deepEqual(uploaded, { fileInfo: "file-info", fileUuid: "uuid", ttl: 300 });

		const digest = (algorithm: "md5" | "sha1") => createHash(algorithm).update(bytes).digest("hex");
		assert.deepEqual(requests.map(({ url, method, body }) => ({ url, method, body })), [
			{
				url: "https://sandbox.api.sgroup.qq.com/v2/users/user%2Fid/upload_prepare",
				method: "POST",
				body: { file_type: 4, file_size: "3", file_name: "a.txt", md5: digest("md5"), sha1: digest("sha1"), md5_10m: digest("md5") },
			},
			{ url: "https://cos.example/upload/0", method: "PUT", body: "abc" },
			{
				url: "https://sandbox.api.sgroup.qq.com/v2/users/user%2Fid/upload_part_finish",
				method: "POST",
				body: { upload_id: "upload-1", part_index: 0, block_size: "3", md5: digest("md5") },
			},
			{
				url: "https://sandbox.api.sgroup.qq.com/v2/users/user%2Fid/files",
				method: "POST",
				body: { file_type: 4, file_name: "a.txt", upload_id: "upload-1", srv_send_msg: false },
			},
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
