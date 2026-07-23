import assert from "node:assert/strict";
import test from "node:test";

import { MessageDedupe } from "../../../src/domain/message-dedupe.ts";
import { ReplyBudget, ReplyBudgetPool } from "../../../src/domain/reply-budget.ts";

class FakeClock {
	time = 0;
	now(): number { return this.time; }
}

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

test("bounds one-off reply budgets without evicting an active message", () => {
	const budgets = new ReplyBudgetPool(4, 2);
	const active = budgets.acquire("active", { pin: true });
	assert.equal(active.reserve("progress"), 1);
	budgets.acquire("command-1");
	budgets.acquire("command-2");
	assert.equal(budgets.size, 2);
	assert.equal(budgets.acquire("active"), active);
	assert.equal(active.reserve("final"), 2);
	budgets.release("active");
	assert.equal(budgets.size, 1);

	const pinnedOnly = new ReplyBudgetPool(4, 1);
	pinnedOnly.acquire("pinned", { pin: true });
	assert.throws(() => pinnedOnly.acquire("overflow"), /capacity/i);
});
