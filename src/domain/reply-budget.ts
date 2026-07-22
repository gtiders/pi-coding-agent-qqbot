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
