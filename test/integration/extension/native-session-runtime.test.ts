import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, SessionInfo } from "@earendil-works/pi-coding-agent";

import { normalizeConfig } from "../../../src/infrastructure/config/normalize-config.ts";
import { NativeSessionRuntime, type NativeTransport } from "../../../src/extension/native-session-runtime.ts";
import { PiCommandBridge } from "../../../src/extension/pi-command-bridge.ts";
import type { QQInboundMessage, QQKeyboard, QQReplyTarget } from "../../../src/application/ports.ts";

const config = normalizeConfig({
	enabled: true,
	appId: "app",
	clientSecret: "secret",
	allowUsers: ["USER-1"],
	allowGroups: [],
	commands: { allowInGroups: false },
});

test("start link stop start retains the logical link and current native session", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	const linked = harness.runtime.link(harness.context);
	await harness.runtime.stop();
	assert.equal(harness.runtime.state.link, linked);
	await harness.runtime.start(harness.context);
	assert.equal(harness.runtime.state.link?.currentSessionId, "native-session-1");
	assert.equal(harness.transportCount(), 2);
});

test("only QQ-originated settled output is returned to QQ", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-1", "hello"));
	assert.equal(harness.injected.length, 1);
	harness.runtime.onAgentEnd(agentEnd("answer from QQ"));
	await harness.runtime.onAgentSettled();
	assert.equal(harness.sent.at(-1)?.text.includes("answer from QQ"), true);

	const count = harness.sent.length;
	harness.runtime.onInput({ type: "input", text: "terminal", source: "interactive" });
	harness.runtime.onAgentEnd(agentEnd("terminal answer"));
	await harness.runtime.onAgentSettled();
	assert.equal(harness.sent.length, count);
});

test("unlink suppresses a stale QQ reply without suppressing native output", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-stale", "slow task"));
	harness.runtime.unlink();
	harness.runtime.onAgentEnd(agentEnd("must stay local"));
	await harness.runtime.onAgentSettled();
	assert.equal(harness.sent.length, 0);
});

test("terminal native session replacement keeps ordinary QQ injection on the new ExtensionAPI", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	const nextContext = {
		...harness.context,
		sessionManager: {
			...harness.context.sessionManager,
			getSessionId: () => "native-session-2",
			getSessionFile: () => "C:/sessions/native-session-2.jsonl",
		},
	} as ExtensionCommandContext;
	harness.runtime.bindExtension(harness.pi);
	harness.runtime.onSessionStart(nextContext);
	await harness.runtime.handleInbound(message("qq-after-terminal-new", "continue here"));
	assert.equal(harness.runtime.state.link?.currentSessionId, "native-session-2");
	assert.equal(harness.injected.length, 1);
});

test("unlinked input is not injected and QQ cannot execute local controls", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	await harness.runtime.handleInbound(message("qq-unlinked", "do not inject"));
	assert.equal(harness.injected.length, 0);
	assert.match(harness.sent.at(-1)?.text ?? "", /qqbot-link/);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-local-control", "/qqbot-stop"));
	assert.equal(harness.runtime.state.gateway, "running");
	assert.match(harness.sent.at(-1)?.text ?? "", /只能由本机 Pi 终端执行/);
});

test("QQ input received while Pi is busy is delivered as a native follow-up", async () => {
	const harness = createHarness(false);
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-follow-up", "wait your turn"));
	assert.deepEqual(harness.injected[0]?.options, { deliverAs: "followUp" });
});

test("QQ command whitelist renders help and model selection keyboards", async () => {
	const models = Array.from({ length: 8 }, (_, index) => ({
		provider: index < 4 ? "deepseek" : "custom",
		id: `model-${index + 1}`,
		name: `Model ${index + 1}`,
		input: ["text"],
		reasoning: true,
	}));
	const harness = createHarness(true, models, [{
		id: "session-12345678",
		path: "C:/sessions/session-12345678.jsonl",
		name: "Refactor session",
		cwd: "C:/work",
		created: new Date(),
		modified: new Date(),
		messageCount: 3,
		firstMessage: "start",
		allMessagesText: "start refactor",
	}]);
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);

	await harness.runtime.handleInbound(message("qq-help", "/help"));
	const helpCommands = keyboardCommands(harness.sent.at(-1)?.keyboard);
	assert.deepEqual(new Set(helpCommands), new Set([
		"/model", "/thinking", "/sessions", "/status", "/new",
		"/resume", "/name", "/compact", "/stop", "/help",
	]));

	await harness.runtime.handleInbound(message("qq-models", "/model"));
	assert.match(harness.sent.at(-1)?.text ?? "", /可用模型 1\/2/);
	assert.ok(keyboardCommands(harness.sent.at(-1)?.keyboard).includes("/model page 2"));

	await harness.runtime.handleInbound(message("qq-models-page", "/model page 2"));
	assert.match(harness.sent.at(-1)?.text ?? "", /可用模型 2\/2/);
	assert.ok(keyboardCommands(harness.sent.at(-1)?.keyboard).includes("/model custom\/model-7"));

	await harness.runtime.handleInbound(message("qq-sessions", "/sessions"));
	assert.deepEqual(keyboardCommands(harness.sent.at(-1)?.keyboard), ["/resume 12345678", "/help"]);

	await harness.runtime.handleInbound(message("qq-model-select", "/model deepseek/model-2"));
	assert.deepEqual(harness.setModels, ["deepseek/model-2"]);
	assert.match(harness.sent.at(-1)?.text ?? "", /立即生效，无需重启 Pi/);

	await harness.runtime.handleInbound(message("qq-reload", "/reload"));
	assert.match(harness.sent.at(-1)?.text ?? "", /只能由本机 Pi 终端执行/);
});

test("thinking command renders level buttons and applies a selected level", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-thinking", "/thinking"));
	assert.ok(keyboardCommands(harness.sent.at(-1)?.keyboard).includes("/thinking xhigh"));
	await harness.runtime.handleInbound(message("qq-thinking-high", "/thinking high"));
	assert.deepEqual(harness.setThinkingLevels, ["high"]);
	assert.match(harness.sent.at(-1)?.text ?? "", /high/);
});

function createHarness(
	idle = true,
	models: Array<Record<string, unknown>> = [],
	sessions: SessionInfo[] = [],
) {
	const sent: Array<{ target: QQReplyTarget; text: string; sequence: number; keyboard?: QQKeyboard }> = [];
	const injected: Array<{ content: unknown; options: unknown }> = [];
	const setModels: string[] = [];
	const setThinkingLevels: string[] = [];
	let thinkingLevel = "medium";
	let transports = 0;
	let runtime!: NativeSessionRuntime;
	const createTransport = (_config: typeof config, callbacks: { onState(state: "connected"): void }): NativeTransport => {
		transports++;
		return {
			gateway: {
				async connect() { callbacks.onState("connected"); },
				close() {},
				async reconnect() {},
			},
			api: {
				async sendText(target, text, sequence) { sent.push({ target, text, sequence }); },
				async sendMarkdown(target, text, sequence, keyboard) { sent.push({ target, text, sequence, ...(keyboard ? { keyboard } : {}) }); },
			},
		};
	};
	runtime = new NativeSessionRuntime({
		bridge: new PiCommandBridge(async () => sessions),
		createTransport: createTransport as never,
		createOwnership: () => ({
			async claim() { return {}; },
			async release() {},
		}),
		createAttachmentPipeline: () => ({
			async prepare(msg: QQInboundMessage) {
				return { prompt: msg.text, images: [], resources: [], async cleanup() {} };
			},
		}) as never,
	});
	runtime.configure(config);
	const pi = {
		sendUserMessage(content: unknown, options: unknown) {
			injected.push({ content, options });
			const text = (content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "";
			runtime.onInput({ type: "input", text, source: "extension" });
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel(level: string) {
			thinkingLevel = level;
			setThinkingLevels.push(level);
		},
		async setModel(model: { provider: string; id: string }) {
			setModels.push(`${model.provider}/${model.id}`);
			return true;
		},
	} as ExtensionAPI;
	runtime.bindExtension(pi);
	const context = {
		cwd: "C:/work",
		model: { provider: "test", id: "model" },
		modelRegistry: { getAvailable: () => models },
		sessionManager: {
			getSessionId: () => "native-session-1",
			getSessionFile: () => "C:/sessions/native-session-1.jsonl",
			getSessionDir: () => "C:/sessions",
			getSessionName: () => undefined,
		},
		isIdle: () => idle,
		hasPendingMessages: () => false,
	} as unknown as ExtensionCommandContext;
	runtime.onSessionStart(context);
	return { runtime, context, pi, sent, injected, setModels, setThinkingLevels, transportCount: () => transports };
}

function message(id: string, text: string): QQInboundMessage {
	return { id, type: "private", text, userOpenId: "USER-1", attachments: [], raw: {}, receivedAt: Date.now() };
}

function agentEnd(text: string) {
	return {
		type: "agent_end" as const,
		messages: [{ role: "assistant" as const, content: [{ type: "text" as const, text }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() }],
	};
}

function keyboardCommands(keyboard?: QQKeyboard): string[] {
	return keyboard?.content.rows.flatMap((row) => row.buttons.map((button) => button.action.data)) ?? [];
}
