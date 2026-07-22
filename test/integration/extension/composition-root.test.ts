import assert from "node:assert/strict";
import test from "node:test";

import piAgentQQBot from "../../../src/index.ts";

test("registers local commands and lifecycle without starting background work", () => {
	const commands = new Set<string>();
	const events = new Set<string>();
	let timers = 0;
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
		timers += 1;
		return originalSetTimeout(...args);
	}) as typeof setTimeout;
	try {
		piAgentQQBot({
			registerCommand(name: string) {
				commands.add(name);
			},
			on(name: string) {
				events.add(name);
			},
		} as never);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
	assert.deepEqual(
		[...commands].sort(),
		[
			"qqbot-approve",
			"qqbot-deny",
			"qqbot-last",
			"qqbot-reconnect",
			"qqbot-requests",
			"qqbot-revoke",
			"qqbot-runtime",
			"qqbot-start",
			"qqbot-status",
			"qqbot-stop",
		].sort(),
	);
	assert.deepEqual([...events].sort(), ["session_shutdown", "session_start"]);
	assert.equal(timers, 0);
});
