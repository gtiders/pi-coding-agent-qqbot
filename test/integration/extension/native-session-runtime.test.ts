import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, SessionInfo } from "@earendil-works/pi-coding-agent";

import { normalizeConfig } from "../../../src/infrastructure/config/normalize-config.ts";
import { NativeSessionRuntime, type NativeTransport } from "../../../src/extension/native-session-runtime.ts";
import { PiCommandBridge } from "../../../src/extension/pi-command-bridge.ts";
import type { QQInboundMessage, QQKeyboard, QQReplyTarget } from "../../../src/application/ports.ts";

const config = normalizeConfig({
	schemaVersion: 5,
	appId: "app",
	clientSecret: "secret",
	ownerOpenId: "USER-1",
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

test("does not impose an extension-level queue length", async () => {
	const harness = createHarness(false);
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	for (let index = 0; index < 25; index++) {
		await harness.runtime.handleInbound(message(`qq-queued-${index}`, `queued ${index}`));
	}
	assert.equal(harness.injected.length, 25);
	assert.ok(harness.injected.every((entry) => (entry.options as { deliverAs?: string }).deliverAs === "followUp"));
});

test("keeps inbound temporary resources until the owning agent turn settles", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-cleanup", "inspect attachment"));
	assert.equal(harness.cleanupCount(), 0);
	harness.runtime.onAgentEnd(agentEnd("done"));
	await harness.runtime.onAgentSettled();
	assert.equal(harness.cleanupCount(), 1);
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

test("QQ approval wins the shared dialog and closes the terminal prompt", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-approval-origin", "perform guarded operation"));

	const result = harness.context.ui.confirm("执行操作？", "这项操作需要批准。此处输入文本。\n并额外补充说明。 ");
	await flushAsync();
	const command = keyboardCommands(harness.sent.at(-1)?.keyboard)
		.find((value) => value.endsWith(" approve"));
	assert.ok(command);
	await harness.runtime.handleInbound(message("qq-approval-click", command));

	assert.equal(await result, true);
	assert.equal(harness.terminalAbortCount(), 1);
	assert.match(harness.sent.at(-1)?.text ?? "", /已批准/);
});

test("interaction card leaves the remaining passive reply budget for a long final answer", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-budget-origin", "perform guarded operation"));

	const result = harness.context.ui.confirm("执行操作？", "确认后生成长回答。 ");
	await flushAsync();
	const command = keyboardCommands(harness.sent.at(-1)?.keyboard)
		.find((value) => value.endsWith(" approve"));
	assert.ok(command);
	await harness.runtime.handleInbound(message("qq-budget-click", command));
	assert.equal(await result, true);

	harness.runtime.onAgentEnd(agentEnd("长回答内容。".repeat(3_000)));
	await harness.runtime.onAgentSettled();
	const originReplies = harness.sent.filter((entry) => entry.target.msgId === "qq-budget-origin");
	assert.deepEqual(originReplies.map((entry) => entry.sequence), [1, 2, 3, 4]);
	assert.match(originReplies.at(-1)?.text ?? "", /后续内容已省略/);
});

test("terminal approval wins and makes the QQ interaction token one-shot", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-terminal-origin", "perform guarded operation"));

	const result = harness.context.ui.confirm("执行操作？", "请选择。 ");
	await flushAsync();
	const command = keyboardCommands(harness.sent.at(-1)?.keyboard)
		.find((value) => value.endsWith(" approve"));
	assert.ok(command);
	harness.resolveTerminalConfirm(false);
	assert.equal(await result, false);
	await harness.runtime.handleInbound(message("qq-late-click", command));
	assert.match(harness.sent.at(-1)?.text ?? "", /另一端处理|失效/);
});

test("QQ selection pages resolve the exact option", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-select-origin", "choose option"));
	const options = Array.from({ length: 8 }, (_, index) => `Option ${index + 1}`);
	const result = harness.context.ui.select("选择目标", options);
	await flushAsync();
	const next = keyboardCommands(harness.sent.at(-1)?.keyboard)
		.find((value) => value.endsWith(" page 2"));
	assert.ok(next);
	await harness.runtime.handleInbound(message("qq-select-page", next));
	const choose = keyboardCommands(harness.sent.at(-1)?.keyboard)
		.find((value) => value.endsWith(" choose 6"));
	assert.ok(choose);
	await harness.runtime.handleInbound(message("qq-select-choice", choose));
	assert.equal(await result, "Option 7");
});

test("QQ text resolves input without entering the agent queue", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-input-origin", "request input"));
	const injectedBeforeReply = harness.injected.length;
	const result = harness.context.ui.input("输入分支名称", "feature/name");
	await flushAsync();
	await harness.runtime.handleInbound(message("qq-input-value", "/feature/qq-ui"));
	assert.equal(await result, "/feature/qq-ui");
	assert.equal(harness.injected.length, injectedBeforeReply);
});

test("standard dialogs stay terminal-only without an active QQ turn", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	const sentBefore = harness.sent.length;
	const result = harness.context.ui.confirm("本地确认", "仅终端处理");
	await flushAsync();
	assert.equal(harness.sent.length, sentBefore);
	harness.resolveTerminalConfirm(true);
	assert.equal(await result, true);
});

test("dialog cancellation invalidates the QQ token without choosing a result", async () => {
	const harness = createHarness();
	await harness.runtime.start(harness.context);
	harness.runtime.link(harness.context);
	await harness.runtime.handleInbound(message("qq-abort-origin", "perform guarded operation"));
	const controller = new AbortController();
	const result = harness.context.ui.confirm("执行操作？", "等待外部取消", { signal: controller.signal });
	await flushAsync();
	const command = keyboardCommands(harness.sent.at(-1)?.keyboard)
		.find((value) => value.endsWith(" approve"));
	assert.ok(command);
	controller.abort();
	assert.equal(await result, false);
	await harness.runtime.handleInbound(message("qq-abort-click", command));
	assert.match(harness.sent.at(-1)?.text ?? "", /另一端处理|失效/);
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
	let cleanups = 0;
	const terminal = createTerminalUI();
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
				return { prompt: msg.text, images: [], resources: [], async cleanup() { cleanups++; } };
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
		ui: terminal.ui,
		mode: "tui",
		hasUI: true,
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
		getContextUsage: () => ({ tokens: 1000, contextWindow: 32_000, percent: 3 }),
	} as unknown as ExtensionCommandContext;
	runtime.onSessionStart(context);
	return {
		runtime,
		context,
		pi,
		sent,
		injected,
		setModels,
		setThinkingLevels,
		transportCount: () => transports,
		cleanupCount: () => cleanups,
		resolveTerminalConfirm: terminal.resolveConfirm,
		terminalAbortCount: terminal.abortCount,
	};
}

function createTerminalUI() {
	const confirmations: Array<(value: boolean) => void> = [];
	let aborts = 0;
	const pending = <T>(queue: Array<(value: T) => void>, fallback: T, signal?: AbortSignal): Promise<T> => new Promise((resolve) => {
		let settled = false;
		const finish = (value: T) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		queue.push(finish);
		signal?.addEventListener("abort", () => {
			aborts++;
			finish(fallback);
		}, { once: true });
	});
	const ui = {
		confirm: (_title: string, _message: string, options?: { signal?: AbortSignal }) => pending(confirmations, false, options?.signal),
		select: (_title: string, _options: string[], options?: { signal?: AbortSignal }) => pending<string | undefined>([], undefined, options?.signal),
		input: (_title: string, _placeholder?: string, options?: { signal?: AbortSignal }) => pending<string | undefined>([], undefined, options?.signal),
		notify() {},
	} as unknown as ExtensionUIContext;
	return {
		ui,
		resolveConfirm(value: boolean) {
			const resolve = confirmations.shift();
			assert.ok(resolve, "expected a pending terminal confirmation");
			resolve(value);
		},
		abortCount: () => aborts,
	};
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
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
