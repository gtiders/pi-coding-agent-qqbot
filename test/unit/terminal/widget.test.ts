import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { TerminalConversationView } from "../../../src/presentation/terminal/widget.ts";

test("terminal view renders TUI events and tolerates a stale UI context", () => {
	const widgets: Array<[string, unknown]> = [];
	const statuses: Array<[string, unknown]> = [];
	let stale = false;
	let renders = 0;
	let component: Component | undefined;
	const theme = { fg: (_color: string, text: string) => text };
	const context = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme,
			setWidget(key: string, factory: unknown) {
				if (stale) throw new Error("stale context");
				widgets.push([key, factory]);
			},
			setStatus(key: string, value: unknown) {
				if (stale) throw new Error("stale context");
				statuses.push([key, value]);
			},
		},
	} as unknown as ExtensionContext;
	const view = new TerminalConversationView(context);
	const factory = widgets[0]?.[1] as ((tui: { requestRender(): void }, theme: unknown) => Component);
	component = factory({ requestRender: () => { renders += 1; } }, theme);
	view.onEvent({
		kind: "inbound",
		messageId: "message-1",
		channel: "private",
		senderLabel: "1234567890123456",
		text: "hello",
		attachmentCount: 0,
		attachmentKinds: [],
		fake: false,
		at: 1,
	});
	assert.equal(renders, 1);
	assert.match(component.render(80).join("\n"), /QQ 123456…3456  hello/);
	stale = true;
	assert.doesNotThrow(() => view.onEvent({
		kind: "runtime_state",
		connection: "connected",
		queueSize: 0,
		running: false,
		at: 2,
	}));
	assert.doesNotThrow(() => view.dispose());
	assert.doesNotThrow(() => view.dispose());
	assert.equal(view.getLines().length, 0);
	view.onEvent({ kind: "error", stage: "late", message: "ignored", at: 3 });
	assert.equal(view.getLines().length, 0);
	assert.ok(statuses.length >= 1);
});

test("terminal view dispose removes widget and status exactly once", () => {
	const widgets: Array<[string, unknown]> = [];
	const statuses: Array<[string, unknown]> = [];
	const context = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWidget(key: string, value: unknown) { widgets.push([key, value]); },
			setStatus(key: string, value: unknown) { statuses.push([key, value]); },
		},
	} as unknown as ExtensionContext;
	const view = new TerminalConversationView(context);
	view.dispose();
	view.dispose();
	assert.equal(widgets.filter(([, value]) => value === undefined).length, 1);
	assert.equal(statuses.filter(([, value]) => value === undefined).length, 1);
});
