import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfig } from "../../../src/infrastructure/config/normalize-config.ts";
import { AgentTurnController } from "../../../src/extension/agent-turn-controller.ts";
import { RemoteCommandController } from "../../../src/extension/remote-command-controller.ts";
import type { QQInboundMessage, QQReplyTarget, QQTerminalEvent } from "../../../src/application/ports.ts";

const config = normalizeConfig({ enabled: true, appId: "test", clientSecret: "test" });

function fakeMessage(text: string): QQInboundMessage {
	return {
		id: "message-1",
		type: "private",
		text,
		userOpenId: "USER",
		attachments: [],
		raw: {},
		receivedAt: Date.now(),
		fake: true,
	};
}

test("remote command controller delegates parsed commands and replies", async () => {
	const replies: string[] = [];
	const controller = new RemoteCommandController({
		config: () => config,
		connectionState: () => "connected",
		queueSize: () => 0,
		getConversation: async () => { throw new Error("not used"); },
		hasActiveOrQueuedConversation: () => false,
		stopConversation: async () => ({ removed: 0, wasRunning: false }),
		reply: async (_message, text) => { replies.push(text); },
		lastSummary: () => "last summary",
		onError: () => { throw new Error("unexpected command error"); },
	});
	await controller.handle(fakeMessage("/last"), "/last");
	assert.deepEqual(replies, ["last summary"]);
});

test("agent turn controller cleans up adapters before finishing runtime state", async () => {
	const calls: string[] = [];
	const replies: string[] = [];
	const events: QQTerminalEvent[] = [];
	const session = {
		supportsImages: () => true,
		bindOutboundDelivery: (delivery: unknown) => { calls.push(delivery ? "bind" : "unbind"); },
		async run() {
			calls.push("run");
			return { text: "answer", tools: [] };
		},
	};
	const pipeline = {
		async prepare() {
			calls.push("prepare");
			return {
				prompt: "question",
				images: [],
				resources: [],
				async cleanup() { calls.push("cleanup"); },
			};
		},
	};
	const controller = new AgentTurnController(pipeline as never, {
		config: () => config,
		api: () => undefined,
		cwd: () => process.cwd(),
		getConversation: async () => session as never,
		beginRun: (_message, _target: QQReplyTarget, abort) => { calls.push("begin"); return abort.signal; },
		finishRun: () => { calls.push("finish"); },
		isRunActive: () => true,
		reply: async (_message, text) => { replies.push(text); },
		deliver: async (_target, text) => { replies.push(text); },
		errorKeyboard: () => undefined,
		sendProgress: async () => undefined,
		hasMediaCapacity: () => true,
		reserveMediaSequence: () => 1,
		setAttachmentStatus: () => undefined,
		setAttachmentError: () => undefined,
		setOutboundStatus: () => undefined,
		setOutboundError: () => undefined,
		recordError: () => undefined,
		emit: (event) => { events.push(event); },
		debug: () => undefined,
		scheduleNext: () => undefined,
	});

	await controller.run(fakeMessage("question"));
	assert.deepEqual(replies, ["answer"]);
	assert.deepEqual(calls, ["begin", "prepare", "bind", "run", "unbind", "cleanup", "finish"]);
	assert.ok(events.some((event) => event.kind === "assistant_start") === false);
});
