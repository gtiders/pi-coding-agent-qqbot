import assert from "node:assert/strict";
import test from "node:test";

import { accessRole, PendingAccessRequests } from "../../../src/domain/access.ts";
import { MessageDedupe } from "../../../src/domain/message-dedupe.ts";
import { BoundedMessageQueue } from "../../../src/domain/message-queue.ts";
import { ReplyBudget } from "../../../src/domain/reply-budget.ts";

class FakeClock {
	time = 0;
	now(): number { return this.time; }
}

test("evaluates users, groups and administrators", () => {
	const policy = { allowUsers: ["USER"], allowGroups: ["GROUP"], admins: ["ADMIN"] };
	assert.equal(accessRole({ type: "private", userOpenId: "ADMIN" }, policy), "admin");
	assert.equal(accessRole({ type: "private", userOpenId: "USER" }, policy), "user");
	assert.equal(accessRole({ type: "group", userOpenId: "OTHER", groupOpenId: "GROUP" }, policy), "user");
	assert.equal(accessRole({ type: "private", userOpenId: "OTHER" }, policy), undefined);
});

test("expires and cools down access requests without storing message text", () => {
	const clock = new FakeClock();
	const requests = new PendingAccessRequests(clock, 100, 50);
	const request = requests.create("USER", "ABC123");
	assert.deepEqual(request, { code: "ABC123", userOpenId: "USER", createdAt: 0, expiresAt: 100 });
	assert.equal("text" in (request ?? {}), false);
	assert.equal(requests.create("USER", "SECOND"), undefined);
	clock.time = 101;
	assert.deepEqual(requests.list(), []);
});

test("deduplicates with TTL and bounded capacity", () => {
	const clock = new FakeClock();
	const dedupe = new MessageDedupe(100, 2, clock);
	assert.equal(dedupe.admit("a"), true);
	assert.equal(dedupe.admit("a"), false);
	assert.equal(dedupe.admit("b"), true);
	assert.equal(dedupe.admit("c"), true);
	assert.equal(dedupe.admit("a"), true);
	clock.time = 101;
	assert.equal(dedupe.admit("c"), true);
});

test("keeps a bounded FIFO and removes one conversation", () => {
	const queue = new BoundedMessageQueue<number>(3);
	assert.equal(queue.enqueue({ conversationKey: "a", message: 1 }), true);
	assert.equal(queue.enqueue({ conversationKey: "b", message: 2 }), true);
	assert.equal(queue.enqueue({ conversationKey: "a", message: 3 }), true);
	assert.equal(queue.enqueue({ conversationKey: "c", message: 4 }), false);
	assert.deepEqual(queue.removeConversation("a").map((item) => item.message), [1, 3]);
	assert.equal(queue.dequeue()?.message, 2);
});

test("owns all passive reply sequence reservations", () => {
	const budget = new ReplyBudget(4);
	assert.equal(budget.reserve("progress", { once: true, keepFinal: true }), 1);
	assert.equal(budget.reserve("progress", { once: true, keepFinal: true }), undefined);
	assert.equal(budget.reserve("media", { keepFinal: true }), 2);
	assert.equal(budget.reserve("markdown"), 3);
	assert.equal(budget.reserve("plain"), 4);
	assert.equal(budget.reserve("final"), undefined);
	assert.equal(budget.remaining, 0);
});
