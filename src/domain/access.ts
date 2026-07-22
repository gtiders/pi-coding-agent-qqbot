import type { Clock } from "./conversation.ts";

export interface AccessSubject {
	type: "private" | "group";
	userOpenId: string;
	groupOpenId?: string;
}

export interface AccessPolicyConfig {
	allowUsers: readonly string[];
	allowGroups: readonly string[];
	admins: readonly string[];
}

export type AccessRole = "user" | "admin";

export function accessRole(subject: AccessSubject, policy: AccessPolicyConfig): AccessRole | undefined {
	if (policy.admins.includes(subject.userOpenId)) return "admin";
	if (policy.allowUsers.includes(subject.userOpenId)) return "user";
	if (subject.type === "group" && subject.groupOpenId && policy.allowGroups.includes(subject.groupOpenId)) return "user";
	return undefined;
}

export interface PendingAccessRequest {
	code: string;
	userOpenId: string;
	createdAt: number;
	expiresAt: number;
}

export class PendingAccessRequests {
	readonly #byCode = new Map<string, PendingAccessRequest>();
	readonly #lastRequest = new Map<string, number>();

	constructor(private readonly clock: Clock, private readonly ttlMs: number, private readonly cooldownMs: number) {}

	create(userOpenId: string, code: string): PendingAccessRequest | undefined {
		const now = this.clock.now();
		this.prune(now);
		const last = this.#lastRequest.get(userOpenId);
		if (last !== undefined && now - last < this.cooldownMs) return undefined;
		const request = { code, userOpenId, createdAt: now, expiresAt: now + this.ttlMs };
		this.#lastRequest.set(userOpenId, now);
		this.#byCode.set(code, request);
		return request;
	}

	consume(code: string): PendingAccessRequest | undefined {
		this.prune(this.clock.now());
		const request = this.#byCode.get(code);
		if (request) this.#byCode.delete(code);
		return request;
	}

	list(): PendingAccessRequest[] {
		this.prune(this.clock.now());
		return [...this.#byCode.values()];
	}

	private prune(now: number): void {
		for (const [code, request] of this.#byCode) if (request.expiresAt <= now) this.#byCode.delete(code);
	}
}
