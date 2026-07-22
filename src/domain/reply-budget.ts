export type ReplyPurpose = "progress" | "busy" | "media" | "markdown" | "plain" | "final";

export class ReplyBudget {
	#next = 1;
	readonly #reserved = new Set<ReplyPurpose>();

	constructor(private readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Reply limit must be a positive integer");
	}

	reserve(purpose: ReplyPurpose, options: { once?: boolean; keepFinal?: boolean } = {}): number | undefined {
		if (options.once && this.#reserved.has(purpose)) return undefined;
		if (options.keepFinal && this.#next >= this.limit) return undefined;
		if (this.#next > this.limit) return undefined;
		this.#reserved.add(purpose);
		return this.#next++;
	}

	get remaining(): number {
		return Math.max(0, this.limit - this.#next + 1);
	}
}

/** Bounded ownership for per-message budgets; active turns can pin their entry. */
export class ReplyBudgetPool {
	readonly #budgets = new Map<string, ReplyBudget>();
	readonly #pinned = new Set<string>();

	constructor(
		private readonly replyLimit: number,
		private readonly maxEntries: number,
	) {
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			throw new RangeError("Reply budget pool capacity must be a positive integer");
		}
	}

	acquire(messageId: string, options: { pin?: boolean } = {}): ReplyBudget {
		let budget = this.#budgets.get(messageId);
		if (budget) {
			this.#budgets.delete(messageId);
			this.#budgets.set(messageId, budget);
		} else {
			this.#evictOneIfFull();
			budget = new ReplyBudget(this.replyLimit);
			this.#budgets.set(messageId, budget);
		}
		if (options.pin) this.#pinned.add(messageId);
		return budget;
	}

	release(messageId: string): void {
		this.#pinned.delete(messageId);
		this.#budgets.delete(messageId);
	}

	clear(): void {
		this.#pinned.clear();
		this.#budgets.clear();
	}

	get size(): number {
		return this.#budgets.size;
	}

	#evictOneIfFull(): void {
		if (this.#budgets.size < this.maxEntries) return;
		for (const messageId of this.#budgets.keys()) {
			if (this.#pinned.has(messageId)) continue;
			this.#budgets.delete(messageId);
			return;
		}
		throw new Error("Reply budget pool capacity is fully pinned");
	}
}
