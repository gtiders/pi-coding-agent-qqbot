export interface QueuedMessage<T> {
	conversationKey: string;
	message: T;
}

export class BoundedMessageQueue<T> {
	readonly #items: Array<QueuedMessage<T>> = [];

	constructor(readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("Queue capacity must be a positive integer");
	}

	get size(): number {
		return this.#items.length;
	}

	get full(): boolean {
		return this.size >= this.capacity;
	}

	enqueue(item: QueuedMessage<T>): boolean {
		if (this.full) return false;
		this.#items.push(item);
		return true;
	}

	dequeue(): QueuedMessage<T> | undefined {
		return this.#items.shift();
	}

	hasConversation(key: string): boolean {
		return this.#items.some((item) => item.conversationKey === key);
	}

	clear(): void {
		this.#items.length = 0;
	}

	removeConversation(key: string): QueuedMessage<T>[] {
		const removed: Array<QueuedMessage<T>> = [];
		for (let index = this.#items.length - 1; index >= 0; index -= 1) {
			const item = this.#items[index];
			if (item?.conversationKey !== key) continue;
			removed.unshift(...this.#items.splice(index, 1));
		}
		return removed;
	}
}
