import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { normalizeConfig } from "../../../src/infrastructure/config/normalize-config.ts";
import { PiAgentQQBotRuntime } from "../../../src/extension/bot-runtime.ts";
import { AgentQQBotHost, acquireAgentQQBotHost } from "../../../src/extension/lifecycle.ts";
import type { PiAgentQQBotConfig, QQConversationObserver, QQTerminalEvent } from "../../../src/application/ports.ts";

const config = normalizeConfig({ enabled: true, appId: "test", clientSecret: "secret" });
const context = { cwd: process.cwd(), mode: "tui", hasUI: true } as ExtensionContext;

interface RuntimeStubs {
	start?: (this: PiAgentQQBotRuntime, ctx: ExtensionContext) => Promise<boolean>;
	stop?: (this: PiAgentQQBotRuntime) => Promise<void>;
	isReady?: (this: PiAgentQQBotRuntime) => boolean;
	bindUiContext?: (this: PiAgentQQBotRuntime, ctx?: ExtensionContext) => void;
	attachObserver?: (this: PiAgentQQBotRuntime, observer: QQConversationObserver) => void;
	detachObserver?: (this: PiAgentQQBotRuntime, observer?: QQConversationObserver) => void;
	applyRuntimeConfig?: (this: PiAgentQQBotRuntime, next: PiAgentQQBotConfig) => void;
}

function stubRuntime(t: TestContext, stubs: RuntimeStubs): void {
	const prototype = PiAgentQQBotRuntime.prototype as unknown as Record<string, unknown>;
	const originals = new Map<string, unknown>();
	for (const [name, replacement] of Object.entries(stubs)) {
		originals.set(name, prototype[name]);
		prototype[name] = replacement;
	}
	t.after(() => {
		for (const [name, original] of originals) prototype[name] = original;
	});
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	assert.fail("condition was not reached");
}

test("start is single-flight for concurrent callers", async (t) => {
	const gate = deferred<boolean>();
	let starts = 0;
	stubRuntime(t, {
		start: async function () {
			starts += 1;
			return gate.promise;
		},
		stop: async () => undefined,
		isReady: () => false,
	});
	const host = new AgentQQBotHost(config, false);
	const first = host.start(context);
	const second = host.start(context);
	await waitFor(() => starts === 1);
	assert.equal(starts, 1);
	gate.resolve(true);
	assert.deepEqual(await Promise.all([first, second]), [true, true]);
	assert.equal(first === second, false, "async callers may receive wrapper promises while sharing one runtime start");
});

test("stop during start wins and leaves no live runtime", async (t) => {
	const gate = deferred<boolean>();
	let starts = 0;
	let stops = 0;
	stubRuntime(t, {
		start: async function () {
			starts += 1;
			return gate.promise;
		},
		stop: async function () {
			stops += 1;
		},
		isReady: () => false,
	});
	const host = new AgentQQBotHost(config, false);
	const starting = host.start(context);
	await waitFor(() => starts === 1);
	const stopping = host.stop();
	gate.resolve(true);
	await stopping;
	assert.equal(await starting, false);
	assert.equal(stops, 1);
	assert.equal(host.getRuntime(), undefined);
	assert.equal(host.getDiagnostics().runtimeStartedAt, undefined);
});

test("start failure cleans up and permits a fresh retry", async (t) => {
	const instances: PiAgentQQBotRuntime[] = [];
	let stops = 0;
	stubRuntime(t, {
		start: async function () {
			instances.push(this);
			if (instances.length === 1) throw new Error("connect failed");
			return true;
		},
		stop: async function () {
			stops += 1;
		},
		isReady: () => false,
	});
	const host = new AgentQQBotHost(config, false);
	await assert.rejects(host.start(context), /connect failed/);
	assert.equal(stops, 1);
	assert.equal(host.getRuntime(), undefined);
	assert.equal(await host.start(context), true);
	assert.equal(instances.length, 2);
	assert.notEqual(instances[0], instances[1]);
});

test("attach and detach track owners, observers, and the current UI context", async (t) => {
	const bindings: Array<ExtensionContext | undefined> = [];
	const attached: QQConversationObserver[] = [];
	const detached: Array<QQConversationObserver | undefined> = [];
	stubRuntime(t, {
		start: async () => true,
		stop: async () => undefined,
		isReady: () => false,
		bindUiContext: function (ctx) { bindings.push(ctx); },
		attachObserver: function (observer) { attached.push(observer); },
		detachObserver: function (observer) { detached.push(observer); },
		applyRuntimeConfig: () => undefined,
	});
	const host = new AgentQQBotHost(config, false);
	await host.start(context);
	const ownerA = Symbol("a");
	const ownerB = Symbol("b");
	const observerA = { onEvent: (_event: QQTerminalEvent) => undefined, dispose: () => undefined };
	const observerB = { onEvent: (_event: QQTerminalEvent) => undefined, dispose: () => undefined };
	const otherContext = { ...context, cwd: "other" } as ExtensionContext;
	host.attach(ownerA, config, observerA, context);
	host.attach(ownerB, config, observerB, otherContext);
	assert.equal(host.ownerCount, 2);
	assert.deepEqual(attached, [observerA, observerB]);
	host.detach(ownerA, observerA);
	assert.equal(host.ownerCount, 1);
	assert.deepEqual(detached, [observerA]);
	assert.notEqual(bindings.at(-1), undefined);
	host.detach(ownerB, observerB);
	assert.equal(host.ownerCount, 0);
	assert.deepEqual(detached, [observerA, observerB]);
	assert.equal(bindings.at(-1), undefined);
});

test("stop is single-flight and remains idempotent after shutdown", async (t) => {
	const stopGate = deferred<void>();
	let stops = 0;
	stubRuntime(t, {
		start: async () => true,
		stop: async function () {
			stops += 1;
			await stopGate.promise;
		},
		isReady: () => false,
	});
	const host = new AgentQQBotHost(config, false);
	await host.start(context);
	const first = host.stop();
	const second = host.stop();
	await waitFor(() => stops === 1);
	assert.equal(stops, 1);
	stopGate.resolve();
	await Promise.all([first, second]);
	await host.stop();
	assert.equal(stops, 1);
});

test("scheduled shutdown coalesces and a replacement owner cancels the handoff timer", async (t) => {
	let stops = 0;
	stubRuntime(t, {
		start: async () => true,
		stop: async function () { stops += 1; },
		isReady: () => false,
		applyRuntimeConfig: () => undefined,
	});
	const first = new AgentQQBotHost(config, false);
	await first.start(context);
	const firstOwner = Symbol("first");
	first.attach(firstOwner, config);
	first.detach(firstOwner);
	first.scheduleStop(5);
	first.scheduleStop(5);
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(stops, 1);

	const replacement = new AgentQQBotHost(config, false);
	await replacement.start(context);
	const oldOwner = Symbol("old");
	const newOwner = Symbol("new");
	replacement.attach(oldOwner, config);
	replacement.detach(oldOwner);
	replacement.scheduleStop(10);
	replacement.attach(newOwner, config);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(stops, 1);
	assert.equal(replacement.ownerCount, 1);
	replacement.detach(newOwner);
	await replacement.stop();
	assert.equal(stops, 2);
});

test("host replacement gives a busy runtime one bounded drain window", async (t) => {
	const calls: string[] = [];
	const symbol = Symbol.for("pi-agent-qqbot.host.v1");
	const globalObject = globalThis as unknown as Record<symbol, unknown>;
	const previous = {
		schema: -1,
		buildId: "old-build",
		getRuntime: () => ({
			isReady: () => true,
			isIdle: () => false,
			waitForIdle: async (timeoutMs: number) => {
				calls.push(`drain:${timeoutMs}`);
				return false;
			},
		}),
		stop: async () => { calls.push("stop"); },
	};
	globalObject[symbol] = previous;
	t.after(() => { delete globalObject[symbol]; });
	const replacement = await acquireAgentQQBotHost(config);
	assert.deepEqual(calls, ["drain:5000", "stop"]);
	assert.equal(replacement.shouldRestoreRuntime(), true);
	assert.match(replacement.getDiagnostics().replacedHost ?? "", /old-build/);
	assert.equal(globalObject[symbol], replacement);
});

test("detaching a stale observer does not remove its replacement", () => {
	const runtime = new PiAgentQQBotRuntime(config);
	const firstEvents: QQTerminalEvent[] = [];
	const secondEvents: QQTerminalEvent[] = [];
	const first = { onEvent: (event: QQTerminalEvent) => { firstEvents.push(event); }, dispose: () => undefined };
	const second = { onEvent: (event: QQTerminalEvent) => { secondEvents.push(event); }, dispose: () => undefined };
	runtime.attachObserver(first);
	runtime.attachObserver(second);
	firstEvents.length = 0;
	secondEvents.length = 0;
	runtime.detachObserver(first);
	(runtime as unknown as { emit(event: QQTerminalEvent): void }).emit({
		kind: "error",
		stage: "test",
		message: "still attached",
		at: 1,
	});
	assert.equal(firstEvents.length, 0);
	assert.equal(secondEvents.length, 1);
});
