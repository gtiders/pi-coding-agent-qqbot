import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
	QQGateway,
	type QQGatewayRuntime,
} from "../../../src/infrastructure/qq/gateway.ts";
import type { ConnectionState, QQInboundMessage } from "../../../src/application/ports.ts";

class FakeWebSocket extends EventEmitter {
	readonly sent: Array<Record<string, unknown>> = [];
	readyState = 1;
	closed = false;

	constructor(readonly url: string) {
		super();
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}

	close(): void {
		this.closed = true;
		this.readyState = 3;
	}

	frame(payload: Record<string, unknown>): void {
		this.emit("message", Buffer.from(JSON.stringify(payload)));
	}
}

interface ScheduledTask {
	callback: () => void;
	delay: number;
}

class FakeTimers {
	private nextId = 1;
	readonly timeouts = new Map<number, ScheduledTask>();
	readonly intervals = new Map<number, ScheduledTask>();

	setTimeout(callback: () => void, delay = 0): number {
		const id = this.nextId++;
		this.timeouts.set(id, { callback, delay });
		return id;
	}

	clearTimeout(timer: unknown): void {
		this.timeouts.delete(Number(timer));
	}

	setInterval(callback: () => void, delay = 0): number {
		const id = this.nextId++;
		this.intervals.set(id, { callback, delay });
		return id;
	}

	clearInterval(timer: unknown): void {
		this.intervals.delete(Number(timer));
	}

	pendingTimeoutDelay(): number | undefined {
		return this.timeouts.values().next().value?.delay;
	}

	async runTimeout(expectedDelay: number): Promise<void> {
		const entry = this.timeouts.entries().next().value as [number, ScheduledTask] | undefined;
		assert.ok(entry, "expected a pending timeout");
		const [id, task] = entry;
		assert.equal(task.delay, expectedDelay);
		this.timeouts.delete(id);
		task.callback();
		await settle();
	}

	runInterval(expectedDelay: number): void {
		const task = [...this.intervals.values()].find((candidate) => candidate.delay === expectedDelay);
		assert.ok(task, `expected a ${expectedDelay}ms interval`);
		task.callback();
	}
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function gatewayHarness() {
	const sockets: FakeWebSocket[] = [];
	const timers = new FakeTimers();
	const states: Array<{ state: ConnectionState; detail?: string }> = [];
	const logs: string[] = [];
	const inbound: QQInboundMessage[] = [];
	const runtime = {
		createWebSocket(url: string) {
			const socket = new FakeWebSocket(url);
			sockets.push(socket);
			return socket;
		},
		setTimeout: timers.setTimeout.bind(timers),
		clearTimeout: timers.clearTimeout.bind(timers),
		setInterval: timers.setInterval.bind(timers),
		clearInterval: timers.clearInterval.bind(timers),
		openReadyState: 1,
	} as unknown as QQGatewayRuntime;
	const gateway = new QQGateway(
		{ getToken: async () => "fake-gateway-token" } as never,
		{ sandbox: true },
		{
			onInbound: (message) => inbound.push(message),
			onState: (state, detail) => states.push(detail === undefined ? { state } : { state, detail }),
			log: (message) => logs.push(message),
		},
		runtime,
	);
	return { gateway, inbound, logs, sockets, states, timers };
}

function gatewayResponse(): Response {
	return new Response(JSON.stringify({ url: "wss://gateway.example.test" }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

test("identifies, heartbeats, becomes READY, resumes, and identifies after invalid session", async () => {
	const originalFetch = globalThis.fetch;
	let gatewayLookups = 0;
	globalThis.fetch = (async () => {
		gatewayLookups += 1;
		return gatewayResponse();
	}) as typeof fetch;

	try {
		const harness = gatewayHarness();
		await harness.gateway.connect();
		assert.equal(harness.sockets.length, 1);
		const initial = harness.sockets[0];
		assert.ok(initial);

		initial.frame({ op: 10, d: { heartbeat_interval: 250 } });
		await settle();
		assert.deepEqual(initial.sent[0], {
			op: 2,
			d: {
				token: "QQBot fake-gateway-token",
				intents: 1 << 25,
				shard: [0, 1],
				properties: {},
			},
		});
		harness.timers.runInterval(250);
		assert.deepEqual(initial.sent[1], { op: 1, d: null });

		initial.frame({ op: 0, t: "READY", s: 42, d: { session_id: "session-1" } });
		assert.equal(harness.states.at(-1)?.state, "connected");
		initial.emit("close", 1006);
		assert.equal(harness.timers.pendingTimeoutDelay(), 1000);
		await harness.timers.runTimeout(1000);

		const resumed = harness.sockets[1];
		assert.ok(resumed);
		resumed.frame({ op: 10, d: { heartbeat_interval: 500 } });
		await settle();
		assert.deepEqual(resumed.sent[0], {
			op: 6,
			d: { token: "QQBot fake-gateway-token", session_id: "session-1", seq: 42 },
		});
		resumed.frame({ op: 0, t: "RESUMED", s: 43, d: {} });
		assert.equal(harness.states.at(-1)?.state, "connected");

		resumed.frame({ op: 9 });
		assert.equal(resumed.closed, true);
		await harness.timers.runTimeout(1000);
		const identified = harness.sockets[2];
		assert.ok(identified);
		identified.frame({ op: 10, d: { heartbeat_interval: 1000 } });
		await settle();
		assert.equal(identified.sent[0]?.op, 2);
		assert.equal(gatewayLookups, 3);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("backs off to the reconnect limit, then manual reconnect resets and close stops timers", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => gatewayResponse()) as typeof fetch;

	try {
		const harness = gatewayHarness();
		await harness.gateway.connect();
		const delays = [1000, 2000, 4000, 8000, 16000];
		for (const [index, delay] of delays.entries()) {
			const socket = harness.sockets[index];
			assert.ok(socket);
			socket.emit("close", 1006);
			assert.equal(harness.timers.pendingTimeoutDelay(), delay);
			await harness.timers.runTimeout(delay);
		}

		assert.equal(harness.sockets.length, 6);
		harness.sockets[5]?.emit("close", 1006);
		assert.equal(harness.timers.timeouts.size, 0);
		assert.match(harness.states.at(-1)?.detail ?? "", /gave up after 5 attempts/);

		await harness.gateway.reconnect();
		assert.equal(harness.sockets.length, 7);
		harness.sockets[6]?.emit("close", 1006);
		assert.equal(harness.timers.pendingTimeoutDelay(), 1000);

		harness.gateway.close();
		assert.equal(harness.timers.timeouts.size, 0);
		assert.equal(harness.timers.intervals.size, 0);
		assert.equal(harness.states.at(-1)?.state, "disconnected");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
