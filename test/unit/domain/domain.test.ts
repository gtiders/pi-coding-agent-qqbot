import assert from "node:assert/strict";
import test from "node:test";

import { MessageDedupe } from "../../../src/domain/message-dedupe.ts";
import { ReplyBudget } from "../../../src/domain/reply-budget.ts";

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
	assert.equal(budget.reserve("media", { keepFinal: true }), 1);
	assert.equal(budget.reserve("media", { keepFinal: true }), 2);
	assert.equal(budget.reserve("media", { keepFinal: true }), 3);
	assert.equal(budget.reserve("media", { keepFinal: true }), undefined);
	assert.equal(budget.reserve("plain"), 4);
	assert.equal(budget.remaining, 0);
});
