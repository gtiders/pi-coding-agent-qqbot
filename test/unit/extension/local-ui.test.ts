import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { confirmAdminApproval } from "../../../src/extension/access-approval-ui.ts";
import { registerLocalCommands } from "../../../src/extension/register-local-commands.ts";

test("local command handlers delegate once and notify with the service result", async () => {
	const handlers = new Map<string, (args: string, context: ExtensionContext) => Promise<void>>();
	const calls: string[] = [];
	registerLocalCommands({
		registerCommand(name: string, command: { handler(args: string, context: ExtensionContext): Promise<void> }) {
			handlers.set(name, command.handler);
		},
	} as never, {
		start: async () => { calls.push("start"); return "started"; },
		stop: async () => { calls.push("stop"); return "stopped"; },
		status: () => { calls.push("status"); return "ready"; },
		reconnect: async () => { calls.push("reconnect"); return "reconnected"; },
	});
	const notifications: Array<[string, string]> = [];
	const context = {
		ui: {
			notify(message: string, level: string) { notifications.push([message, level]); },
		},
	} as ExtensionContext;
	for (const name of ["qqbot-start", "qqbot-stop", "qqbot-status", "qqbot-reconnect"]) {
		await handlers.get(name)?.("", context);
	}
	assert.deepEqual(calls, ["start", "stop", "status", "reconnect"]);
	assert.deepEqual(notifications, [
		["started", "info"],
		["stopped", "info"],
		["ready", "info"],
		["reconnected", "info"],
	]);
});

test("admin approval rejects non-UI contexts without touching UI methods", async () => {
	let confirmations = 0;
	const context = {
		hasUI: false,
		ui: {
			confirm: async () => {
				confirmations += 1;
				return true;
			},
		},
	} as unknown as ExtensionContext;
	assert.equal(await confirmAdminApproval(context, "abc…xyz"), false);
	assert.equal(confirmations, 0);
});

test("admin approval delegates to the TUI confirmation dialog", async () => {
	const prompts: string[][] = [];
	const context = {
		hasUI: true,
		ui: {
			confirm: async (...args: string[]) => {
				prompts.push(args);
				return true;
			},
		},
	} as unknown as ExtensionContext;
	assert.equal(await confirmAdminApproval(context, "abc…xyz"), true);
	assert.deepEqual(prompts, [["授予 QQ 管理员权限？", "用户 abc…xyz 将能够管理 QQ 会话。"]]);
});
