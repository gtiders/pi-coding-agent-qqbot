import assert from "node:assert/strict";
import test from "node:test";

import type { QQAgentRunEvent } from "../../../src/infrastructure/pi/agent-session.ts";
import { QQAgentSession } from "../../../src/infrastructure/pi/agent-session.ts";
import { createFakePiSdk } from "./fake-sdk.ts";

test("initializes a recent persistent Pi runtime and excludes recursive QQ bot extensions", async () => {
	const { sdk, state } = createFakePiSdk();
	const session = new QQAgentSession(async () => sdk);

	await session.init("C:/workspace", {
		persistent: true,
		restore: "recent",
		sessionDir: "C:/agent/qqbot/sessions/conversation",
	});

	assert.equal(session.isReady(), true);
	assert.deepEqual(state.sessionManagers, [{
		kind: "recent",
		cwd: "C:/workspace",
		sessionDir: "C:/agent/qqbot/sessions/conversation",
	}]);
	assert.equal(state.runtimesCreated, 1);
	assert.equal(state.bindCalls, 1);
	assert.equal(state.definedTools.length, 1);
	assert.ok(state.hostExtensionSettings.includes("host-extension"));
	assert.ok(state.hostExtensionSettings.includes("!**/pi-agent-qqbot/**"));
	assert.deepEqual(state.filteredExtensions, [{ path: "C:/extensions/keep/index.ts" }]);
});

test("runs prompts, reports assistant and tool events, and returns the final answer", async () => {
	const { sdk, state } = createFakePiSdk();
	const session = new QQAgentSession(async () => sdk);
	await session.init("C:/workspace", { persistent: false });
	const events: QQAgentRunEvent[] = [];
	const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

	const result = await session.run("inspect this", [image], (event) => events.push(event));

	assert.equal(result.text, "hello world");
	assert.deepEqual(result.tools, [{
		toolCallId: "call-1",
		name: "read",
		args: { path: "a.txt" },
		isError: false,
	}]);
	assert.deepEqual(events, [
		{ kind: "assistant_start" },
		{ kind: "assistant_delta", delta: "hello " },
		{ kind: "assistant_end" },
		{ kind: "tool_start", toolCallId: "call-1", toolName: "read", args: { path: "a.txt" } },
		{ kind: "tool_end", toolCallId: "call-1", toolName: "read", isError: false },
	]);
	assert.deepEqual(state.promptCalls, [{
		prompt: "inspect this",
		options: { images: [image], source: "extension" },
	}]);
});

test("aborts and disposes the runtime once", async () => {
	const { sdk, state } = createFakePiSdk();
	const session = new QQAgentSession(async () => sdk);
	await session.init("C:/workspace", { persistent: false });

	await session.abort();
	await session.dispose();
	await session.dispose();

	assert.equal(state.abortCalls, 1);
	assert.equal(state.runtimeDisposeCalls, 1);
	assert.equal(state.sessionDisposeCalls, 1);
	assert.equal(session.isReady(), false);
	await assert.rejects(() => session.run("after dispose"), /not initialized/);
});

test("cleans up a created runtime when initialization fails while binding extensions", async () => {
	const { sdk, state } = createFakePiSdk({ failBindCount: 1 });
	const session = new QQAgentSession(async () => sdk);

	await assert.rejects(
		() => session.init("C:/workspace", { persistent: false }),
		/fake extension bind failure/,
	);

	assert.equal(session.isReady(), false);
	assert.equal(state.runtimesCreated, 1);
	assert.equal(state.runtimeDisposeCalls, 1);
	assert.equal(state.sessionDisposeCalls, 1);
});
