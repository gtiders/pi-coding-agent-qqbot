import assert from "node:assert/strict";
import test from "node:test";

import { NativeSessionLinkState } from "../../../src/domain/native-session-link.ts";

test("gateway stop and restart retain the logical link and active session", () => {
	const state = new NativeSessionLinkState("runtime-1", () => 100);
	state.setGateway("running");
	const linked = state.bind("app", "user", { sessionId: "session-a", sessionFile: "a.jsonl" });
	state.setGateway("stopped");
	state.updateSession({ sessionId: "session-b", sessionFile: "b.jsonl" });
	state.setGateway("running");
	assert.equal(state.link, linked);
	assert.equal(state.link?.currentSessionId, "session-b");
	assert.equal(state.link?.currentSessionFile, "b.jsonl");
});

test("unlink advances generation and suppresses stale QQ origins", () => {
	const state = new NativeSessionLinkState("runtime-1");
	const link = state.bind("app", "user", { sessionId: "session-a" });
	const origin = { source: "qq" as const, generation: link.generation, messageId: "message-1" };
	assert.equal(state.isCurrentQQOrigin(origin), true);
	state.unlink();
	assert.equal(state.isCurrentQQOrigin(origin), false);
	const replacement = state.bind("app", "user", { sessionId: "session-a" });
	assert.ok(replacement.generation > origin.generation);
});
