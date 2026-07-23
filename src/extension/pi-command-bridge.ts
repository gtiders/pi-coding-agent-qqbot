import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";

type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
export type ReplacedSessionContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

export interface NativeSessionInfo {
	id: string;
	path: string;
	name?: string | undefined;
	cwd: string;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}

export interface NativeRuntimeStatus {
	sessionId: string;
	sessionFile?: string | undefined;
	sessionName?: string | undefined;
	model?: string | undefined;
	thinking: string;
	idle: boolean;
	hasPendingMessages: boolean;
}

export interface NativeModelInfo {
	provider: string;
	id: string;
	name: string;
}

type SessionLister = (cwd: string, sessionDir?: string) => Promise<SessionInfo[]>;

export class PiCommandBridge {
	private pi: ExtensionAPI | undefined;
	private sessionContext: ExtensionContext | undefined;
	private commandContext: ExtensionCommandContext | undefined;

	constructor(private readonly listNativeSessions: SessionLister = (cwd, sessionDir) => SessionManager.list(cwd, sessionDir)) {}

	bindExtension(pi: ExtensionAPI): void {
		this.pi = pi;
		// A new ExtensionAPI belongs to a new runner. A replacement initiated
		// through this bridge restores the command context in withSession.
		this.commandContext = undefined;
	}

	captureCommandContext(ctx: ExtensionCommandContext): void {
		this.commandContext = ctx;
		this.sessionContext = ctx;
	}

	observeSessionContext(ctx: ExtensionContext): void {
		this.sessionContext = ctx;
	}

	hasCommandContext(): boolean {
		return this.commandContext !== undefined;
	}

	async newSession(name?: string): Promise<void> {
		const ctx = this.requireContext();
		const result = await ctx.newSession({
			withSession: async (fresh) => {
				this.captureReplacement(fresh);
				if (name?.trim()) this.requirePi().setSessionName(name.trim());
			},
		});
		if (result.cancelled) throw new Error("native session replacement was cancelled");
	}

	async listSessions(query = ""): Promise<ReadonlyArray<NativeSessionInfo>> {
		const ctx = this.requireSessionContext();
		const sessions = await this.listNativeSessions(ctx.cwd, ctx.sessionManager.getSessionDir());
		const needle = query.trim().toLowerCase();
		return sessions
			.filter((entry) => !needle || sessionSearchText(entry).includes(needle))
			.map(toNativeSessionInfo);
	}

	async resumeSession(selector: string): Promise<void> {
		const ctx = this.requireContext();
		const match = resolveSessionSelector(await this.listSessions(), selector);
		const result = await ctx.switchSession(match.path, {
			withSession: async (fresh) => this.captureReplacement(fresh),
		});
		if (result.cancelled) throw new Error("native session replacement was cancelled");
	}

	setSessionName(name: string): void {
		const normalized = name.trim();
		if (!normalized) throw new Error("session name is required");
		this.requirePi().setSessionName(normalized);
	}

	compact(instructions?: string): Promise<void> {
		const ctx = this.requireSessionContext();
		return new Promise<void>((resolve, reject) => {
			ctx.compact({
				...(instructions?.trim() ? { customInstructions: instructions.trim() } : {}),
				onComplete: () => resolve(),
				onError: reject,
			});
		});
	}

	async setModel(selector: string): Promise<string> {
		const ctx = this.requireSessionContext();
		const needle = selector.trim().toLowerCase();
		if (!needle) throw new Error("model selector is required");
		const models = ctx.modelRegistry.getAvailable();
		const exact = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === needle);
		const matches = exact.length ? exact : models.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle));
		if (matches.length !== 1) throw new Error(matches.length ? "model selector is ambiguous" : "model was not found or is not configured");
		const model = matches[0]!;
		if (!(await this.requirePi().setModel(model))) throw new Error("model authentication is not configured");
		return `${model.provider}/${model.id}`;
	}

	listModels(query = ""): ReadonlyArray<NativeModelInfo> {
		const needle = query.trim().toLowerCase();
		return this.requireSessionContext().modelRegistry.getAvailable()
			.filter((model) => !needle || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle))
			.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
	}

	setThinking(level?: string): string {
		const pi = this.requirePi();
		if (level?.trim()) {
			pi.setThinkingLevel(level.trim().toLowerCase() as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
		}
		return pi.getThinkingLevel();
	}

	stopCurrentTurn(): void {
		this.requireSessionContext().abort();
	}

	status(): NativeRuntimeStatus {
		const ctx = this.requireSessionContext();
		const model = ctx.model;
		return {
			sessionId: ctx.sessionManager.getSessionId(),
			...(ctx.sessionManager.getSessionFile() ? { sessionFile: ctx.sessionManager.getSessionFile() } : {}),
			...(ctx.sessionManager.getSessionName() ? { sessionName: ctx.sessionManager.getSessionName() } : {}),
			...(model ? { model: `${model.provider}/${model.id}` } : {}),
			thinking: this.requirePi().getThinkingLevel(),
			idle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
		};
	}

	private captureReplacement(ctx: ReplacedSessionContext): void {
		this.captureCommandContext(ctx);
	}

	private requireContext(): ExtensionCommandContext {
		if (!this.commandContext) throw new Error("native Pi command context is unavailable; run /qqbot-start locally");
		return this.commandContext;
	}

	private requireSessionContext(): ExtensionContext {
		if (!this.sessionContext) throw new Error("native Pi session context is unavailable");
		return this.sessionContext;
	}

	private requirePi(): ExtensionAPI {
		if (!this.pi) throw new Error("native Pi extension API is unavailable");
		return this.pi;
	}
}

function sessionSearchText(entry: SessionInfo): string {
	return `${entry.id} ${entry.name ?? ""} ${entry.firstMessage} ${entry.allMessagesText}`.toLowerCase();
}

function toNativeSessionInfo(entry: SessionInfo): NativeSessionInfo {
	return {
		id: entry.id,
		path: entry.path,
		...(entry.name ? { name: entry.name } : {}),
		cwd: entry.cwd,
		modified: entry.modified,
		messageCount: entry.messageCount,
		firstMessage: entry.firstMessage,
	};
}

function resolveSessionSelector(sessions: ReadonlyArray<NativeSessionInfo>, selector: string): NativeSessionInfo {
	const needle = selector.trim().toLowerCase();
	if (!needle) throw new Error("session selector is required");
	const matches = sessions.filter((entry) => {
		const compactId = entry.id.replace(/[^a-z0-9]/gi, "").toLowerCase();
		return compactId.startsWith(needle) || compactId.endsWith(needle) || entry.name?.toLowerCase() === needle;
	});
	if (matches.length === 0) throw new Error("native Pi session was not found");
	if (matches.length > 1) throw new Error("native Pi session selector is ambiguous");
	return matches[0]!;
}
