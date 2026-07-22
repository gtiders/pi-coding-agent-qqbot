import assert from "node:assert/strict";
import test from "node:test";

import { QQApi, QQApiError } from "../../../src/infrastructure/qq/api.ts";

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
	authorization: string | null;
}

const privateTarget = {
	type: "private" as const,
	userOpenId: "user/id",
	msgId: "private-message",
	createdAt: 1,
};
const groupTarget = {
	type: "group" as const,
	userOpenId: "member-id",
	groupOpenId: "group/id",
	msgId: "group-message",
	createdAt: 2,
};

test("builds C2C and group passive-reply requests", async () => {
	const originalFetch = globalThis.fetch;
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		requests.push({
			url: String(input),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			authorization: headers.get("Authorization"),
		});
		return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;

	try {
		const api = new QQApi({ getToken: async () => "fake-token" } as never, { sandbox: true });
		await api.sendText(privateTarget, "hello", 1);
		await api.sendMarkdown(groupTarget, "**hello**", 2, {
			content: { rows: [{ buttons: [] }] },
		});

		assert.deepEqual(requests, [
			{
				url: "https://sandbox.api.sgroup.qq.com/v2/users/user%2Fid/messages",
				body: { content: "hello", msg_type: 0, msg_id: "private-message", msg_seq: 1 },
				authorization: "QQBot fake-token",
			},
			{
				url: "https://sandbox.api.sgroup.qq.com/v2/groups/group%2Fid/messages",
				body: {
					markdown: { content: "**hello**" },
					msg_type: 2,
					msg_id: "group-message",
					msg_seq: 2,
					keyboard: { content: { rows: [{ buttons: [] }] } },
					content: " ",
				},
				authorization: "QQBot fake-token",
			},
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("marks HTTP failures accepted without retrying", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		return new Response(JSON.stringify({ code: 22009, message: "reply limit" }), {
			status: 429,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;

	try {
		const api = new QQApi({ getToken: async () => "fake-token" } as never, { sandbox: false });
		await assert.rejects(api.sendText(privateTarget, "hello", 1), (error: unknown) => {
			assert.ok(error instanceof QQApiError);
			assert.equal(error.status, 429);
			assert.equal(error.code, 22009);
			assert.equal(error.requestAccepted, true);
			return true;
		});
		assert.equal(fetchCalls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("marks transport failures unaccepted without retrying", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		throw new Error("offline");
	}) as typeof fetch;

	try {
		const api = new QQApi({ getToken: async () => "fake-token" } as never, { sandbox: false });
		await assert.rejects(api.sendText(privateTarget, "hello", 1), (error: unknown) => {
			assert.ok(error instanceof QQApiError);
			assert.equal(error.status, 0);
			assert.equal(error.requestAccepted, false);
			return true;
		});
		assert.equal(fetchCalls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
