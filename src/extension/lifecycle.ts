import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { PiAgentQQBotRuntime } from "./bot-runtime";
import type { PiAgentQQBotConfig, QQConversationObserver } from "../application/ports";

const HOST_SYMBOL = Symbol.for("pi-agent-qqbot.host.v1");

// Bump this whenever the in-memory runtime contract changes. A reload must not
// retain a Gateway host created by older router or transport code.
export const QQBOT_HOST_SCHEMA = 2;
export const QQBOT_BUILD_ID = createSourceBuildId();

interface GlobalWithQQHost {
	[HOST_SYMBOL]?: AgentQQBotHost;
}

export interface AgentQQBotHostDiagnostics {
	buildId: string;
	schema: number;
	createdAt: number;
	runtimeStartedAt?: number | undefined;
	ownerCount: number;
	runtimeReady: boolean;
	restoreRuntime: boolean;
	replacedHost?: string;
}

export class AgentQQBotHost {
	readonly schema = QQBOT_HOST_SCHEMA;
	readonly buildId = QQBOT_BUILD_ID;
	readonly createdAt = Date.now();
	private config: PiAgentQQBotConfig;
	private configFingerprint: string;
	private runtime: PiAgentQQBotRuntime | undefined;
	private runtimeStartedAt: number | undefined;
	private startPromise: Promise<boolean> | undefined;
	private stopPromise: Promise<void> | undefined;
	private lifecycleGeneration = 0;
	private stopTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly owners = new Set<symbol>();

	constructor(
		config: PiAgentQQBotConfig,
		private readonly restoreRuntime: boolean,
		private readonly replacedHost?: string | undefined,
	) {
		this.config = config;
		this.configFingerprint = fingerprint(config);
	}

	getRuntime(): PiAgentQQBotRuntime | undefined {
		return this.runtime;
	}

	getDiagnostics(): AgentQQBotHostDiagnostics {
		return {
			buildId: this.buildId,
			schema: this.schema,
			createdAt: this.createdAt,
			runtimeStartedAt: this.runtimeStartedAt,
			ownerCount: this.owners.size,
			runtimeReady: this.runtime?.isReady() === true,
			restoreRuntime: this.restoreRuntime,
			...(this.replacedHost ? { replacedHost: this.replacedHost } : {}),
		};
	}

	applyRuntimeConfig(config: PiAgentQQBotConfig): void {
		this.config = config;
		this.configFingerprint = fingerprint(config);
		this.runtime?.applyRuntimeConfig(config);
	}

	// Kept for the approval/revoke command call sites.
	applyAccessConfig(config: PiAgentQQBotConfig): void {
		this.applyRuntimeConfig(config);
	}

	get ownerCount(): number {
		return this.owners.size;
	}

	shouldRestoreRuntime(): boolean {
		return this.restoreRuntime && !this.runtime?.isReady();
	}

	matchesConfig(config: PiAgentQQBotConfig): boolean {
		return this.configFingerprint === fingerprint(config);
	}

	attach(owner: symbol, config: PiAgentQQBotConfig, observer?: QQConversationObserver, ctx?: ExtensionContext): void {
		if (this.stopTimer) clearTimeout(this.stopTimer);
		this.stopTimer = undefined;
		this.owners.add(owner);
		// Config changes that do not alter the runtime fingerprint (for example
		// page size, allowlists, and command UI settings) take effect immediately.
		this.applyRuntimeConfig(config);
		if (ctx) this.runtime?.bindUiContext(ctx);
		if (observer) this.runtime?.attachObserver(observer);
	}

	detach(owner: symbol, observer?: QQConversationObserver): void {
		if (observer) this.runtime?.detachObserver(observer);
		this.owners.delete(owner);
		// Drop the local TUI ctx as soon as no extension owns the host so gateway
		// callbacks during session handoff cannot touch a stale ExtensionContext.
		if (this.owners.size === 0) this.runtime?.bindUiContext(undefined);
	}

	async start(ctx: ExtensionContext, observer?: QQConversationObserver): Promise<boolean> {
		if (this.stopTimer) clearTimeout(this.stopTimer);
		this.stopTimer = undefined;
		if (this.stopPromise) await this.stopPromise;
		if (this.runtime?.isReady()) {
			this.runtime.bindUiContext(ctx);
			if (observer) this.runtime.attachObserver(observer);
			return true;
		}
		if (this.startPromise) return this.startPromise;
		const runtime = new PiAgentQQBotRuntime(this.config);
		const generation = this.lifecycleGeneration;
		this.runtime = runtime;
		if (observer) runtime.attachObserver(observer);
		const pending = (async () => {
			let started: boolean;
			try {
				started = await runtime.start(ctx);
			} catch (error) {
				if (this.runtime === runtime && this.lifecycleGeneration === generation) {
					this.runtime = undefined;
					await runtime.stop();
				}
				throw error;
			}
			if (this.runtime !== runtime || this.lifecycleGeneration !== generation) return false;
			if (!started) {
				this.runtime = undefined;
				await runtime.stop();
				return false;
			}
			this.runtimeStartedAt = Date.now();
			return true;
		})();
		this.startPromise = pending;
		try {
			return await pending;
		} finally {
			if (this.startPromise === pending) this.startPromise = undefined;
		}
	}

	/**
	 * Local session replacement gets a grace period so the new extension
	 * instance can attach without tearing down the QQ gateway.
	 */
	scheduleStop(graceMs: number): void {
		if (this.owners.size > 0 || this.stopTimer) return;
		this.stopTimer = setTimeout(() => {
			this.stopTimer = undefined;
			if (this.owners.size === 0) void this.stop();
		}, graceMs);
		this.stopTimer.unref?.();
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (this.stopTimer) clearTimeout(this.stopTimer);
		this.stopTimer = undefined;
		const runtime = this.runtime;
		const starting = this.startPromise;
		this.runtime = undefined;
		this.runtimeStartedAt = undefined;
		this.lifecycleGeneration += 1;
		const pending = (async () => {
			if (starting) {
				try {
					await starting;
				} catch {
					// The caller of start observes the startup error; stop still owns cleanup.
				}
			}
			await runtime?.stop();
		})();
		this.stopPromise = pending;
		try {
			await pending;
		} finally {
			if (this.stopPromise === pending) this.stopPromise = undefined;
		}
	}
}

export async function acquireAgentQQBotHost(config: PiAgentQQBotConfig): Promise<AgentQQBotHost> {
	const globalObject = globalThis as GlobalWithQQHost;
	const existing = globalObject[HOST_SYMBOL];
	if (existing?.schema === QQBOT_HOST_SCHEMA && existing.buildId === QQBOT_BUILD_ID && existing.matchesConfig(config)) {
		return existing;
	}
	const restoreRuntime = existing?.getRuntime()?.isReady() === true;
	const replacedHost = existing
		? `schema=${String(existing.schema)}, build=${existing.buildId ?? "unknown"}`
		: undefined;
	if (existing) {
		const previousRuntime = existing.getRuntime() as (PiAgentQQBotRuntime & {
			isIdle?: () => boolean;
			waitForIdle?: (timeoutMs: number) => Promise<boolean>;
		}) | undefined;
		// Give an in-flight QQ request a bounded drain window before replacement.
		// Older in-memory runtimes do not expose these helpers, so capability-test
		// before forcing the replacement.
		if (previousRuntime?.isIdle && previousRuntime.waitForIdle && !previousRuntime.isIdle()) {
			await previousRuntime.waitForIdle(5_000);
		}
		await existing.stop();
	}
	const host = new AgentQQBotHost(config, restoreRuntime, replacedHost);
	globalObject[HOST_SYMBOL] = host;
	return host;
}

export function createSourceBuildId(sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..")): string {
	const hash = createHash("sha256");
	for (const path of collectSourceFiles(sourceRoot).sort()) {
		hash.update(relative(sourceRoot, path).replaceAll("\\", "/")).update("\0").update(readFileSync(path));
	}
	return `src-${hash.digest("hex").slice(0, 16)}`;
}

function collectSourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectSourceFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
	}
	return files;
}

function fingerprint(config: PiAgentQQBotConfig): string {
	return JSON.stringify({
		appId: config.appId,
		clientSecret: config.clientSecret,
		sandbox: config.sandbox,
		sessions: config.sessions,
		media: config.media,
		outboundMedia: config.outboundMedia,
		maxQueueSize: config.maxQueueSize,
	});
}
