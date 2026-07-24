export type ReplyPurpose = "media" | "markdown" | "plain";

export class ReplyBudget {
	#next = 1;

	constructor(private readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Reply limit must be a positive integer");
	}

	reserve(_purpose: ReplyPurpose, options: { keepFinal?: boolean } = {}): number | undefined {
		if (options.keepFinal && this.#next >= this.limit) return undefined;
		if (this.#next > this.limit) return undefined;
		return this.#next++;
	}

	get remaining(): number {
		return Math.max(0, this.limit - this.#next + 1);
	}
}
