import assert from "node:assert/strict";
import test from "node:test";

import { renderConversationLines } from "../../../src/presentation/terminal/conversation-view.ts";
import { disposeTerminalState, initialTerminalState, reduceTerminalEvent } from "../../../src/presentation/terminal/event-reducer.ts";

test("reduces runtime state and bounds terminal history", () => {
	let state = reduceTerminalEvent(initialTerminalState(), {
		kind: "runtime_state",
		connection: "connected",
		queueSize: 2,
		running: true,
		at: 1,
	});
	assert.equal(state.connection, "connected");
	assert.equal(state.queueSize, 2);
	assert.equal(state.running, true);
	for (let index = 0; index < 4; index += 1) {
		state = reduceTerminalEvent(state, {
			kind: "inbound",
			messageId: String(index),
			channel: "private",
			senderLabel: "USER",
			text: `message-${index}`,
			attachmentCount: 0,
			attachmentKinds: [],
			fake: false,
			at: index + 2,
		}, 3);
	}
	assert.deepEqual(state.lines.map((line) => line.text), ["message-1", "message-2", "message-3"]);
	assert.deepEqual(renderConversationLines(state, 6), ["messa…", "messa…", "messa…"]);
	const disposed = disposeTerminalState(state);
	assert.equal(disposed.disposed, true);
	assert.equal(reduceTerminalEvent(disposed, { kind: "error", stage: "test", message: "ignored", at: 9 }), disposed);
});
