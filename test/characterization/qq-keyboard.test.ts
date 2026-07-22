import assert from "node:assert/strict";
import test from "node:test";

import { buildCommandKeyboard } from "../../src/presentation/qq/keyboard";
import type { QQInboundMessage } from "../../src/application/ports";

test("bounds QQ command keyboards", () => {
	const message: QQInboundMessage = {
		id: "test",
		type: "private",
		text: "/model",
		userOpenId: "user",
		attachments: [],
		raw: {},
		receivedAt: Date.now(),
	};
	const keyboard = buildCommandKeyboard(
		message,
		Array.from({ length: 7 }, (_, row) =>
			Array.from({ length: 7 }, (_, column) => ({ label: `button-${row}-${column}`, command: `/model ${row}-${column}` })),
		),
	);
	assert.ok(keyboard);
	assert.equal(keyboard.content.rows.length, 5);
	assert.ok(keyboard.content.rows.every((row) => row.buttons.length === 5));
	assert.equal(keyboard.content.rows[0]?.buttons[0]?.action.enter, true);
	assert.equal(keyboard.content.rows[0]?.buttons[0]?.action.type, 2);
});
