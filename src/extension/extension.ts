import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ConfigRepositoryError, FileConfigRepository } from "../infrastructure/config/config-repository.ts";
import { CONFIG_PATH, validateEnabled } from "../infrastructure/config/normalize-config.ts";
import type { PiAgentQQBotConfig } from "../application/ports.ts";
import { NativeSessionRuntime } from "./native-session-runtime.ts";
import { formatBytes } from "../infrastructure/media/outbound-media.ts";

const RUNTIME_SYMBOL = Symbol.for("pi-agent-qqbot.native-session-runtime.v1");
const globalState = globalThis as typeof globalThis & {
	[RUNTIME_SYMBOL]?: NativeSessionRuntime;
};
const runtime = globalState[RUNTIME_SYMBOL] ?? new NativeSessionRuntime();
globalState[RUNTIME_SYMBOL] = runtime;

const configRepository = new FileConfigRepository(CONFIG_PATH);
let currentConfig: PiAgentQQBotConfig = runtimeConfigFallback();

export default function registerExtension(pi: ExtensionAPI): void {
	runtime.bindExtension(pi);
	pi.registerTool({
		name: "qq_send_local_file",
		label: "Send Local File to QQ",
		description: "Send one real local computer file to the QQ conversation that requested the current task. Use only when that QQ user explicitly asks to send, upload, or transfer a local image or file. The target and reply metadata are bound by pi-agent-qqbot; provide only the local path.",
		parameters: Type.Object({
			path: Type.String({ description: "Local file path returned by a tool or explicitly provided by the QQ user" }),
		}),
		async execute(_toolCallId, params) {
			const record = await runtime.sendLocalFile(params.path, "auto");
			return {
				content: [{
					type: "text",
					text: `QQ API 已确认发送${record.kind === "image" ? "图片" : "文件"} ${record.filename}（${formatBytes(record.bytes)}）。`,
				}],
				details: record,
			};
		},
	});

	const requireConfig = (ctx: ExtensionCommandContext): boolean => {
		if (!currentConfig.enabled) {
			ctx.ui.notify("pi-agent-qqbot 未启用，请在 ~/.pi/agent/pi-agent-qqbot.json 设置 enabled=true", "warning");
			return false;
		}
		const invalid = validateEnabled(currentConfig);
		if (invalid) {
			ctx.ui.notify(`pi-agent-qqbot 配置无效：${invalid}`, "warning");
			return false;
		}
		return true;
	};

	pi.registerCommand("qqbot-start", {
		description: "Start the QQ Gateway for the current Pi runtime",
		handler: async (_args, ctx) => {
			if (!requireConfig(ctx)) return;
			try {
				runtime.configure(currentConfig);
				await runtime.start(ctx, {
					confirmTakeover: ({ pid }) => ctx.ui.confirm(
						"接管 QQ Gateway？",
						`本机 Pi 进程 ${pid} 当前拥有该 QQ Bot。接管只会停止旧进程的 Gateway，不会终止旧 Pi。`,
					),
				});
				ctx.ui.notify(`pi-agent-qqbot started\n${runtime.statusText()}`, "info");
			} catch (error) {
				ctx.ui.notify(`pi-agent-qqbot 启动失败：${safeError(error)}`, "error");
			}
		},
	});

	pi.registerCommand("qqbot-link", {
		description: "Bind the configured QQ C2C conversation to this Pi session",
		handler: async (_args, ctx) => {
			if (!requireConfig(ctx)) return;
			try {
				runtime.configure(currentConfig);
				const link = runtime.link(ctx);
				ctx.ui.notify(`QQ 已绑定到当前 Pi 会话 ${link.currentSessionId}`, "info");
			} catch (error) {
				ctx.ui.notify(`pi-agent-qqbot link 失败：${safeError(error)}`, "error");
			}
		},
	});

	pi.registerCommand("qqbot-stop", {
		description: "Stop only the QQ Gateway transport",
		handler: async (_args, ctx) => {
			await runtime.stop();
			ctx.ui.notify("QQ Gateway 已停止；逻辑绑定和当前 Pi 会话已保留。", "info");
		},
	});

	pi.registerCommand("qqbot-unlink", {
		description: "Clear the in-process QQ logical link",
		handler: async (_args, ctx) => {
			runtime.unlink();
			ctx.ui.notify("QQ logical link 已解除。", "info");
		},
	});

	pi.registerCommand("qqbot-status", {
		description: "Show QQ Gateway and native Pi link status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(runtime.statusText(), "info");
		},
	});

	pi.registerCommand("qqbot-takeover", {
		description: "Take over QQ Gateway ownership from another local Pi process",
		handler: async (_args, ctx) => {
			if (!requireConfig(ctx)) return;
			try {
				runtime.configure(currentConfig);
				await runtime.start(ctx, { forceTakeover: true });
				ctx.ui.notify(`QQ Gateway ownership 已接管。\n${runtime.statusText()}`, "info");
			} catch (error) {
				ctx.ui.notify(`QQ Gateway 接管失败：${safeError(error)}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const loaded = await configRepository.load();
			currentConfig = loaded.config;
			runtime.configure(currentConfig);
			runtime.onSessionStart(ctx);
			if (loaded.missing && ctx.hasUI) ctx.ui.notify("pi-agent-qqbot 未找到配置，保持禁用。", "info");
		} catch (error) {
			currentConfig = runtimeConfigFallback();
			if (ctx.hasUI) {
				const code = error instanceof ConfigRepositoryError ? error.code : "read_failed";
				ctx.ui.notify(`pi-agent-qqbot 配置读取失败：${code}`, "warning");
			}
		}
	});

	pi.on("input", async (event) => {
		runtime.onInput(event);
	});
	pi.on("agent_end", async (event) => {
		runtime.onAgentEnd(event);
	});
	pi.on("agent_settled", async () => {
		await runtime.onAgentSettled();
	});
	pi.on("session_shutdown", async (event: SessionShutdownEvent) => {
		if (event.reason === "quit") await runtime.shutdownProcess();
	});
}

function runtimeConfigFallback(): PiAgentQQBotConfig {
	return {
		schemaVersion: 4 as const,
		enabled: false,
		appId: "",
		clientSecret: "",
		allowUsers: [],
		allowGroups: [],
		commands: { allowInGroups: false, buttons: true, maxListItems: 5, modelPageSize: 6 },
		link: { conflictPolicy: "ask" as const },
		replyFormat: "auto" as const,
		progress: { enabled: false, ackAfterMs: 0 },
		outboundMedia: { enabled: false, adminsOnly: false, allowPrivate: false, allowGroups: false, deniedRoots: [], images: false, files: false, maxFilesPerTurn: 1, maxImageBytes: 1, maxFileBytes: 1, maxTotalBytes: 1, uploadTimeoutMs: 5000 },
		media: { enabled: false, maxAttachments: 1, maxTotalBytes: 1, downloadTimeoutMs: 1000, image: { enabled: false, maxBytes: 1 }, voice: { enabled: false, preferQQAsr: false, maxBytes: 1 }, documents: { enabled: false, allowExtensions: [".txt"], maxTxtBytes: 1, maxPdfBytes: 1, maxDocBytes: 1, maxPdfPages: 1, maxExtractedChars: 1 } },
		debug: false,
	};
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}
