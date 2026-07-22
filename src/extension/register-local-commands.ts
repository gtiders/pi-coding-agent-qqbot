import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface LocalCommandServices {
	start(): Promise<string>;
	stop(): Promise<string>;
	status(): string;
	reconnect(): Promise<string>;
}

export function registerLocalCommands(pi: ExtensionAPI, services: LocalCommandServices): void {
	for (const [name, run] of [
		["qqbot-start", () => services.start()],
		["qqbot-stop", () => services.stop()],
		["qqbot-status", async () => services.status()],
		["qqbot-reconnect", () => services.reconnect()],
	] as const) {
		pi.registerCommand(name, {
			description: `pi-agent-qqbot ${name.slice("qqbot-".length)}`,
			handler: async (_args, context) => context.ui.notify(await run(), "info"),
		});
	}
}
