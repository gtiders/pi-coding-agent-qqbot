import assert from "node:assert/strict";
import test from "node:test";

import piAgentQQBot from "../../../src/index.ts";

test("registers local commands and lifecycle without starting background work", () => {
	const commands = new Set<string>();
	const events = new Set<string>();
	const tools = new Set<string>();
	let timers = 0;
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
		timers += 1;
		return originalSetTimeout(...args);
	}) as typeof setTimeout;
	try {
		piAgentQQBot({
			registerTool(tool: { name: string }) {
				tools.add(tool.name);
			},
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
			"qqbot-link",
			"qqbot-start",
			"qqbot-status",
			"qqbot-stop",
			"qqbot-takeover",
			"qqbot-unlink",
		].sort(),
	);
	assert.deepEqual([...events].sort(), ["agent_end", "agent_settled", "input", "session_shutdown", "session_start"]);
	assert.deepEqual([...tools], ["qq_send_local_file"]);
	assert.equal(timers, 0);
});
