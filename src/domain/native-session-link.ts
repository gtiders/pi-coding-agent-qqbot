import { randomUUID } from "node:crypto";

export type GatewayState = "stopped" | "starting" | "running" | "stopping" | "failed";

export interface NativeSessionIdentity {
	sessionId: string;
	sessionFile?: string | undefined;
}

export interface LogicalLink {
	appId: string;
	userOpenId: string;
	runtimeId: string;
	currentSessionId: string;
	currentSessionFile?: string | undefined;
	generation: number;
	linkedAt: number;
}

export type TurnOrigin =
	| { source: "terminal" }
	| { source: "qq"; generation: number; messageId: string };

export class NativeSessionLinkState {
	readonly runtimeId: string;
	private gatewayValue: GatewayState = "stopped";
	private linkValue: LogicalLink | undefined;
	private generationValue = 0;

	constructor(runtimeId: string = randomUUID(), private readonly clock: () => number = Date.now) {
		this.runtimeId = runtimeId;
	}

	get gateway(): GatewayState {
		return this.gatewayValue;
	}

	get link(): Readonly<LogicalLink> | undefined {
		return this.linkValue;
	}

	setGateway(state: GatewayState): void {
		this.gatewayValue = state;
	}

	bind(appId: string, userOpenId: string, session: NativeSessionIdentity): Readonly<LogicalLink> {
		const current = this.linkValue;
		if (current && current.appId === appId && current.userOpenId === userOpenId) {
			this.updateSession(session);
			return current;
		}
		this.linkValue = {
			appId,
			userOpenId,
			runtimeId: this.runtimeId,
			currentSessionId: session.sessionId,
			...(session.sessionFile ? { currentSessionFile: session.sessionFile } : {}),
			generation: ++this.generationValue,
			linkedAt: this.clock(),
		};
		return this.linkValue;
	}

	adopt(link: Omit<LogicalLink, "runtimeId">): Readonly<LogicalLink> {
		this.linkValue = {
			...link,
			runtimeId: this.runtimeId,
			generation: Math.max(this.generationValue, link.generation ?? 0) + 1,
		};
		this.generationValue = this.linkValue.generation;
		return this.linkValue;
	}

	updateSession(session: NativeSessionIdentity): void {
		if (!this.linkValue) return;
		this.linkValue.currentSessionId = session.sessionId;
		if (session.sessionFile) this.linkValue.currentSessionFile = session.sessionFile;
		else delete this.linkValue.currentSessionFile;
	}

	unlink(): void {
		this.generationValue++;
		this.linkValue = undefined;
	}

	clearForProcessExit(): void {
		this.unlink();
		this.gatewayValue = "stopped";
	}

	isCurrentQQOrigin(origin: TurnOrigin): origin is Extract<TurnOrigin, { source: "qq" }> {
		return origin.source === "qq" && this.linkValue?.generation === origin.generation;
	}
}
