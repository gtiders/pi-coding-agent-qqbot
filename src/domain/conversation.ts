export interface Clock {
	now(): number;
}

export interface ConversationId {
	type: "private" | "group";
	value: string;
}

export function conversationKey(conversation: ConversationId): string {
	return `${conversation.type}:${conversation.value}`;
}
