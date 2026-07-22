import assert from "node:assert/strict";
import test from "node:test";

import { deliverReply } from "../../../src/application/deliver-reply.ts";
import { processInboundMessage } from "../../../src/application/process-inbound-message.ts";
import { runAgentTurn } from "../../../src/application/run-agent-turn.ts";
import { MessageDedupe } from "../../../src/domain/message-dedupe.ts";
import { ReplyBudget } from "../../../src/domain/reply-budget.ts";
import type { AgentSessionPort, QQReplyPort, QQReplyTarget } from "../../../src/application/ports.ts";

const policy = { allowUsers: ["USER"], allowGroups: ["GROUP"], admins: ["ADMIN"] };

test("authorizes before deduplicating inbound messages", () => {
	let now = 100;
	const dedupe = new MessageDedupe(1_000, 10, { now: () => now });
	const denied = processInboundMessage(
		{ id: "same-id", subject: { type: "private", userOpenId: "DENIED" }, message: "secret" },
		policy,
		dedupe,
	);
	assert.deepEqual(denied, { kind: "denied" });
	const accepted = processInboundMessage(
		{ id: "same-id", subject: { type: "private", userOpenId: "USER" }, message: "allowed" },
		policy,
		dedupe,
	);
	assert.deepEqual(accepted, { kind: "accepted", role: "user", message: "allowed" });
	assert.deepEqual(
		processInboundMessage(
			{ id: "same-id", subject: { type: "private", userOpenId: "USER" }, message: "duplicate" },
			policy,
			dedupe,
		),
		{ kind: "duplicate" },
	);
	now += 1_001;
	assert.equal(
		processInboundMessage(
			{ id: "same-id", subject: { type: "private", userOpenId: "ADMIN" }, message: "after ttl" },
			policy,
			dedupe,
		).kind,
		"accepted",
	);
});

test("always closes outbound delivery and prepared attachments", async () => {
	const primary = new Error("agent failed");
	const cleanupErrors: Array<{ error: unknown; primary?: unknown }> = [];
	const calls: string[] = [];
	const session: AgentSessionPort = {
		async run() {
			calls.push("run");
			throw primary;
		},
		async abort() {},
		async dispose() {},
	};
	await assert.rejects(
		() =>
			runAgentTurn(
				session,
				{
					async prepare() {
						return {
							input: { prompt: "test", images: [] },
							async cleanup() {
								calls.push("attachments");
								throw new Error("attachment cleanup failed");
							},
						};
					},
				},
				async () => {
					calls.push("outbound");
					throw new Error("outbound cleanup failed");
				},
				(error, original) => cleanupErrors.push({ error, primary: original }),
			),
		primary,
	);
	assert.deepEqual(calls, ["run", "outbound", "attachments"]);
	assert.equal(cleanupErrors.length, 2);
	assert.ok(cleanupErrors.every((entry) => entry.primary === primary));
});

test("delivers progress and final text from one reply budget", async () => {
	const sent: Array<{ text: string; seq: number }> = [];
	const replies: QQReplyPort = {
		async sendText(_target, text, seq) {
			sent.push({ text, seq });
		},
	};
	const target: QQReplyTarget = {
		type: "private",
		userOpenId: "USER",
		msgId: "message",
		createdAt: Date.now(),
	};
	await deliverReply(replies, new ReplyBudget(4), { target, progress: "working", text: "done" });
	assert.deepEqual(sent, [
		{ text: "working", seq: 1 },
		{ text: "done", seq: 2 },
	]);
});
