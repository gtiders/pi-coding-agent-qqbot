import type { Clock } from "./conversation.ts";

export class MessageDedupe {
	readonly #entries = new Map<string, number>();

	constructor(private readonly ttlMs: number, private readonly capacity: number, private readonly clock: Clock) {}

	admit(id: string): boolean {
		const now = this.clock.now();
		this.prune(now);
		if (this.#entries.has(id)) return false;
		this.#entries.set(id, now + this.ttlMs);
		while (this.#entries.size > this.capacity) {
			const oldest = this.#entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
		return true;
	}

	private prune(now: number): void {
		for (const [id, expiresAt] of this.#entries) {
			if (expiresAt > now) continue;
			this.#entries.delete(id);
		}
	}
}
