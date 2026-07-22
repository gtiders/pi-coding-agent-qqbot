import type { AccessPolicyConfig, AccessSubject } from "../domain/access.ts";
import { accessRole } from "../domain/access.ts";
import type { MessageDedupe } from "../domain/message-dedupe.ts";

export interface InboundEnvelope<T> {
	id: string;
	subject: AccessSubject;
	message: T;
}

export type InboundDecision<T> =
	| { kind: "denied" }
	| { kind: "duplicate" }
	| { kind: "accepted"; role: "user" | "admin"; message: T };

export function processInboundMessage<T>(envelope: InboundEnvelope<T>, policy: AccessPolicyConfig, dedupe: MessageDedupe): InboundDecision<T> {
	const role = accessRole(envelope.subject, policy);
	if (!role) return { kind: "denied" };
	if (!dedupe.admit(envelope.id)) return { kind: "duplicate" };
	return { kind: "accepted", role, message: envelope.message };
}
