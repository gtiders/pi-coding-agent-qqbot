import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { PiCommandBridge, type ReplacedSessionContext } from "../../../src/extension/pi-command-bridge.ts";

test("deferred native new refreshes context and uses the rebound ExtensionAPI for name", async () => {
	const names: string[] = [];
	let bridge: PiCommandBridge;
	const fresh = fakeContext("session-2");
	const initial = fakeContext("session-1", async (options) => {
		bridge.bindExtension(fakePi(names));
		await options?.withSession?.(fresh as ReplacedSessionContext);
		return { cancelled: false };
	});
	bridge = new PiCommandBridge(async () => []);
	bridge.bindExtension(fakePi(names));
	bridge.captureCommandContext(initial);

	await bridge.newSession("native name");
	assert.deepEqual(names, ["native name"]);
	assert.equal(bridge.status().sessionId, "session-2");
	await bridge.newSession();
});

function fakePi(names: string[]): ExtensionAPI {
	return {
		setSessionName(name: string) { names.push(name); },
		getThinkingLevel: () => "medium",
	} as ExtensionAPI;
}

function fakeContext(
	sessionId: string,
	newSession: ExtensionCommandContext["newSession"] = async (options) => {
		await options?.withSession?.(fakeContext(`${sessionId}-next`) as ReplacedSessionContext);
		return { cancelled: false };
	},
): ExtensionCommandContext {
	return {
		cwd: "C:/work",
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => `${sessionId}.jsonl`,
			getSessionDir: () => "C:/sessions",
			getSessionName: () => undefined,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		newSession,
	} as unknown as ExtensionCommandContext;
}
