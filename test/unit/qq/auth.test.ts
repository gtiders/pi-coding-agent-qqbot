import assert from "node:assert/strict";
import test from "node:test";

import { QQAuth, QQAuthError } from "../../../src/infrastructure/qq/auth.ts";

function tokenResponse(token: string, expiresIn = 7200): Response {
	return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

test("coalesces concurrent token requests into one in-flight fetch", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	let resolveFetch: ((response: Response) => void) | undefined;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		return await new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
	}) as typeof fetch;

	try {
		const auth = new QQAuth("fake-app", "fake-secret");
		const first = auth.getToken();
		const second = auth.getToken();
		assert.equal(fetchCalls, 1);
		resolveFetch?.(tokenResponse("token-1"));
		assert.deepEqual(await Promise.all([first, second]), ["token-1", "token-1"]);
		assert.equal(fetchCalls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("caches tokens and refreshes at the refresh margin", async () => {
	const originalFetch = globalThis.fetch;
	const originalNow = Date.now;
	let now = 1_000_000;
	let fetchCalls = 0;
	Date.now = () => now;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		return tokenResponse(`token-${fetchCalls}`, 120);
	}) as typeof fetch;

	try {
		const auth = new QQAuth("fake-app", "fake-secret");
		assert.equal(await auth.getToken(), "token-1");
		now += 59_999;
		assert.equal(await auth.getToken(), "token-1");
		assert.equal(fetchCalls, 1);
		now += 1;
		assert.equal(await auth.getToken(), "token-2");
		assert.equal(fetchCalls, 2);

		auth.invalidate();
		assert.equal(await auth.getToken(), "token-3");
		assert.equal(fetchCalls, 3);
	} finally {
		Date.now = originalNow;
		globalThis.fetch = originalFetch;
	}
});

test("redacts configured credentials from transport and server errors", async () => {
	const originalFetch = globalThis.fetch;
	const appId = "credential-app-id";
	const secret = "credential-client-secret";
	const auth = new QQAuth(appId, secret);

	try {
		globalThis.fetch = (async () => {
			throw new Error(`transport exposed ${appId} and ${secret}`);
		}) as typeof fetch;
		await assert.rejects(auth.getToken(), (error: unknown) => {
			assert.ok(error instanceof QQAuthError);
			assert.equal(error.message.includes(appId), false);
			assert.equal(error.message.includes(secret), false);
			assert.match(error.message, /\[redacted\]/);
			return true;
		});

		globalThis.fetch = (async () => new Response(JSON.stringify({
			code: 401,
			message: `invalid ${appId}:${secret}`,
		}), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		})) as typeof fetch;
		await assert.rejects(auth.getToken(), (error: unknown) => {
			assert.ok(error instanceof QQAuthError);
			assert.equal(error.message.includes(appId), false);
			assert.equal(error.message.includes(secret), false);
			assert.match(error.message, /auth failed \(status 401\)/);
			return true;
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});
