import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PiAgentQQBotConfig, QQInboundMessage } from "../../../src/application/ports.ts";
import { normalizeConfig } from "../../../src/infrastructure/config/normalize-config.ts";
import { QQAgentSession } from "../../../src/infrastructure/pi/agent-session.ts";
import { ConversationRegistry } from "../../../src/infrastructure/pi/conversation-registry.ts";
import { createFakePiSdk } from "./fake-sdk.ts";

function config(overrides: Partial<PiAgentQQBotConfig["sessions"]> = {}): PiAgentQQBotConfig {
	const value = normalizeConfig({});
	Object.assign(value.sessions, overrides);
	return value;
}

function message(userOpenId: string, groupOpenId?: string): QQInboundMessage {
	return {
		id: `message-${userOpenId}`,
		type: groupOpenId ? "group" : "private",
		text: "hello",
		userOpenId,
		...(groupOpenId ? { groupOpenId } : {}),
		attachments: [],
		raw: {},
		receivedAt: 1,
	};
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

async function createRegistry(
	t: test.TestContext,
	registryConfig: PiAgentQQBotConfig,
	fakeOptions: Parameters<typeof createFakePiSdk>[0] = {},
): Promise<{
	registry: ConversationRegistry;
	state: ReturnType<typeof createFakePiSdk>["state"];
}> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-registry-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	const { sdk, state } = createFakePiSdk(fakeOptions);
	const registry = new ConversationRegistry(
		registryConfig,
		agentDir,
		"C:/workspace",
		() => new QQAgentSession(async () => sdk),
	);
	t.after(() => registry.dispose());
	return { registry, state };
}

test("initializes one session for concurrent requests to the same conversation", async (t) => {
	const gate = deferred();
	const { registry, state } = await createRegistry(t, config(), { servicesGate: gate.promise });
	const inbound = message("user-a");

	const first = registry.get(inbound);
	const second = registry.get(inbound);
	gate.resolve();
	const [firstSession, secondSession] = await Promise.all([first, second]);

	assert.equal(firstSession, secondSession);
	assert.equal(registry.residentCount, 1);
	assert.equal(state.runtimesCreated, 1);
	assert.equal(state.sessionManagers.length, 1);
});

test("does not exceed the resident limit while another conversation initializes", async (t) => {
	const gate = deferred();
	const { registry, state } = await createRegistry(t, config({ maxResident: 1 }), { servicesGate: gate.promise });
	const first = registry.get(message("user-a"));
	while (registry.residentCount === 0) await new Promise((resolve) => setImmediate(resolve));

	await assert.rejects(
		() => registry.get(message("user-b")),
		/会话资源已满/,
	);
	gate.resolve();
	await first;

	assert.equal(registry.residentCount, 1);
	assert.equal(state.runtimesCreated, 1);
	assert.equal(state.sessionManagers.length, 1);
});

test("isolates different conversations and restores each most recent persistent session", async (t) => {
	const { registry, state } = await createRegistry(t, config({ restore: "recent" }));

	const privateSession = await registry.get(message("user-a"));
	const groupSession = await registry.get(message("member-a", "group-a"));
	const sameGroupSession = await registry.get(message("member-b", "group-a"));

	assert.notEqual(privateSession, groupSession);
	assert.equal(groupSession, sameGroupSession);
	assert.equal(registry.residentCount, 2);
	assert.deepEqual(state.sessionManagers.map((record) => record.kind), ["recent", "recent"]);
	assert.equal(new Set(state.sessionManagers.map((record) => record.sessionDir)).size, 2);
});

test("evicts idle sessions before creating a new conversation", async (t) => {
	const originalNow = Date.now;
	let now = 100;
	Date.now = () => now;
	t.after(() => {
		Date.now = originalNow;
	});
	const { registry, state } = await createRegistry(t, config({ idleDisposeMs: 50 }));
	const firstMessage = message("user-a");
	await registry.get(firstMessage);

	now = 200;
	await registry.get(message("user-b"));

	assert.equal(registry.peek(firstMessage), undefined);
	assert.equal(registry.residentCount, 1);
	assert.equal(state.runtimeDisposeCalls, 1);
});

test("evicts the least recently used non-streaming session at the resident limit", async (t) => {
	const originalNow = Date.now;
	let now = 100;
	Date.now = () => now;
	t.after(() => {
		Date.now = originalNow;
	});
	const { registry, state } = await createRegistry(t, config({ maxResident: 2, idleDisposeMs: 10_000 }));
	const firstMessage = message("user-a");
	const secondMessage = message("user-b");
	await registry.get(firstMessage);
	now = 200;
	await registry.get(secondMessage);
	now = 300;
	await registry.get(firstMessage);

	now = 400;
	await registry.get(message("user-c"));

	assert.ok(registry.peek(firstMessage));
	assert.equal(registry.peek(secondMessage), undefined);
	assert.equal(registry.residentCount, 2);
	assert.equal(state.runtimeDisposeCalls, 1);
});

test("removes and disposes a failed initialization so the conversation can retry", async (t) => {
	const { registry, state } = await createRegistry(t, config(), { failBindCount: 1 });
	const inbound = message("user-a");

	await assert.rejects(() => registry.get(inbound), /fake extension bind failure/);
	assert.equal(registry.residentCount, 0);
	assert.equal(state.runtimeDisposeCalls, 1);

	const retry = await registry.get(inbound);
	assert.equal(retry.isReady(), true);
	assert.equal(registry.residentCount, 1);
	assert.equal(state.runtimesCreated, 2);
});

test("dispose waits for initialization, rejects the pending get, and disposes all sessions", async (t) => {
	const gate = deferred();
	const { registry, state } = await createRegistry(t, config(), { servicesGate: gate.promise });
	const pendingGet = registry.get(message("user-a"));
	while (registry.residentCount === 0) await new Promise((resolve) => setImmediate(resolve));

	const pendingDispose = registry.dispose();
	gate.resolve();
	await assert.rejects(() => pendingGet, /registry is disposed/);
	await pendingDispose;

	assert.equal(registry.residentCount, 0);
	assert.equal(state.runtimeDisposeCalls, 1);
	await assert.rejects(() => registry.get(message("user-b")), /registry is disposed/);
});
