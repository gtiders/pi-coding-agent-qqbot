import { conversationKey } from "../domain/conversation.ts";
import { BoundedMessageQueue } from "../domain/message-queue.ts";
import type { QQInboundMessage } from "./ports.ts";

export class MessageQueue {
	readonly #queue: BoundedMessageQueue<QQInboundMessage>;

	constructor(maxSize: number) {
		this.#queue = new BoundedMessageQueue(maxSize);
	}

	get size(): number {
		return this.#queue.size;
	}

	enqueue(message: QQInboundMessage): boolean {
		return this.#queue.enqueue({ conversationKey: messageKey(message), message });
	}

	dequeue(): QQInboundMessage | undefined {
		return this.#queue.dequeue()?.message;
	}

	clear(): void {
		this.#queue.clear();
	}

	hasConversation(message: QQInboundMessage): boolean {
		return this.#queue.hasConversation(messageKey(message));
	}

	removeConversation(message: QQInboundMessage): number {
		return this.#queue.removeConversation(messageKey(message)).length;
	}
}

function messageKey(message: QQInboundMessage): string {
	return conversationKey({
		type: message.type,
		value: message.type === "group" ? message.groupOpenId ?? message.userOpenId : message.userOpenId,
	});
}
