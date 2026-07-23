/** Config loading and strict normalization for pi-agent-qqbot. */

import { homedir } from "node:os";
import { join } from "node:path";

import type { PiAgentQQBotConfig, QQMediaConfig, QQMediaSttConfig, QQOutboundMediaConfig } from "../../application/ports";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-agent-qqbot.json");

const OUTBOUND_MEDIA_DEFAULTS: QQOutboundMediaConfig = {
	enabled: false,
	adminsOnly: true,
	allowPrivate: true,
	allowGroups: false,
	deniedRoots: [],
	images: true,
	files: true,
	maxFilesPerTurn: 2,
	maxImageBytes: 10 * 1024 * 1024,
	maxFileBytes: 20 * 1024 * 1024,
	maxTotalBytes: 30 * 1024 * 1024,
	uploadTimeoutMs: 30_000,
};

const MEDIA_DEFAULTS: QQMediaConfig = {
	enabled: true,
	maxAttachments: 4,
	maxTotalBytes: 30 * 1024 * 1024,
	downloadTimeoutMs: 120_000,
	image: { enabled: true, maxBytes: 10 * 1024 * 1024 },
	voice: { enabled: true, preferQQAsr: true, maxBytes: 25 * 1024 * 1024 },
	documents: {
		enabled: true,
		allowExtensions: [".txt", ".pdf", ".doc"],
		maxTxtBytes: 2 * 1024 * 1024,
		maxPdfBytes: 20 * 1024 * 1024,
		maxDocBytes: 10 * 1024 * 1024,
		maxPdfPages: 100,
		maxExtractedChars: 150_000,
	},
};

const DEFAULTS: PiAgentQQBotConfig = {
	schemaVersion: 4,
	enabled: false,
	appId: "",
	clientSecret: "",
	sandbox: true,
	allowUsers: [],
	allowGroups: [],
	replyPrefix: "",
	maxQueueSize: 20,
	sendBusyNotice: false,
	commands: {
		allowInGroups: false,
		buttons: true,
		maxListItems: 5,
		modelPageSize: 6,
	},
	link: {
		conflictPolicy: "ask",
	},
	showProcess: false,
	replyFormat: "auto",
	progress: {
		enabled: true,
		ackAfterMs: 3_000,
	},
	outboundMedia: OUTBOUND_MEDIA_DEFAULTS,
	media: MEDIA_DEFAULTS,
	debug: false,
};

export interface LoadConfigResult {
	config: PiAgentQQBotConfig;
	missing?: boolean;
	parseError?: string;
}

export function normalizeConfig(parsed: unknown): PiAgentQQBotConfig {
	const raw = isRecord(parsed) ? parsed : {};
	const rawMedia = isRecord(raw.media) ? raw.media : {};
	const rawOutboundMedia = isRecord(raw.outboundMedia) ? raw.outboundMedia : {};
	const rawImage = isRecord(rawMedia.image) ? rawMedia.image : {};
	const rawVoice = isRecord(rawMedia.voice) ? rawMedia.voice : {};
	const rawDocuments = isRecord(rawMedia.documents) ? rawMedia.documents : {};
	const rawStt = isRecord(rawVoice.stt) ? rawVoice.stt : undefined;
	const rawCommands = isRecord(raw.commands) ? raw.commands : {};
	const rawLink = isRecord(raw.link) ? raw.link : {};
	const rawProgress = isRecord(raw.progress) ? raw.progress : {};

	const config: PiAgentQQBotConfig = {
		...DEFAULTS,
		schemaVersion: 4,
		enabled: bool(raw.enabled, DEFAULTS.enabled),
		appId: stringValue(raw.appId, ""),
		clientSecret: stringValue(raw.clientSecret, ""),
		sandbox: bool(raw.sandbox, true),
		allowUsers: stringArray(raw.allowUsers).map((value) => value.trim()),
		allowGroups: stringArray(raw.allowGroups).map((value) => value.trim()),
		replyPrefix: stringValue(raw.replyPrefix, ""),
		maxQueueSize: integer(raw.maxQueueSize, 20, 1, 1000),
		sendBusyNotice: bool(raw.sendBusyNotice, false),
		commands: {
			allowInGroups: bool(rawCommands.allowInGroups, false),
			buttons: bool(rawCommands.buttons, true),
			maxListItems: integer(rawCommands.maxListItems, 5, 1, 10),
			// QQ keyboards permit at most five rows. Six models use three rows,
			// leaving room for page navigation and the help action.
			modelPageSize: integer(rawCommands.modelPageSize, 6, 1, 6),
		},
		link: {
			conflictPolicy: rawLink.conflictPolicy === "takeover" ? "takeover" : "ask",
		},
		showProcess: bool(raw.showProcess, false),
		replyFormat: raw.replyFormat === "plain" ? "plain" : "auto",
		progress: {
			enabled: bool(rawProgress.enabled, DEFAULTS.progress.enabled),
			ackAfterMs: integer(rawProgress.ackAfterMs, DEFAULTS.progress.ackAfterMs, 0, 60_000),
		},
		debug: bool(raw.debug, false),
		outboundMedia: {
			enabled: bool(rawOutboundMedia.enabled, OUTBOUND_MEDIA_DEFAULTS.enabled),
			adminsOnly: bool(rawOutboundMedia.adminsOnly, OUTBOUND_MEDIA_DEFAULTS.adminsOnly),
			allowPrivate: bool(rawOutboundMedia.allowPrivate, OUTBOUND_MEDIA_DEFAULTS.allowPrivate),
			allowGroups: bool(rawOutboundMedia.allowGroups, OUTBOUND_MEDIA_DEFAULTS.allowGroups),
			deniedRoots: [...new Set(
				stringArray(rawOutboundMedia.deniedRoots)
					.map((value) => value.trim())
					.filter(Boolean),
			)].slice(0, 20),
			images: bool(rawOutboundMedia.images, OUTBOUND_MEDIA_DEFAULTS.images),
			files: bool(rawOutboundMedia.files, OUTBOUND_MEDIA_DEFAULTS.files),
			maxFilesPerTurn: integer(rawOutboundMedia.maxFilesPerTurn, OUTBOUND_MEDIA_DEFAULTS.maxFilesPerTurn, 1, 3),
			maxImageBytes: integer(rawOutboundMedia.maxImageBytes, OUTBOUND_MEDIA_DEFAULTS.maxImageBytes, 1, 25 * 1024 * 1024),
			maxFileBytes: integer(rawOutboundMedia.maxFileBytes, OUTBOUND_MEDIA_DEFAULTS.maxFileBytes, 1, 50 * 1024 * 1024),
			maxTotalBytes: integer(rawOutboundMedia.maxTotalBytes, OUTBOUND_MEDIA_DEFAULTS.maxTotalBytes, 1, 75 * 1024 * 1024),
			uploadTimeoutMs: integer(rawOutboundMedia.uploadTimeoutMs, OUTBOUND_MEDIA_DEFAULTS.uploadTimeoutMs, 5_000, 120_000),
		},
		media: {
			enabled: bool(rawMedia.enabled, MEDIA_DEFAULTS.enabled),
			maxAttachments: integer(rawMedia.maxAttachments, 4, 1, 10),
			maxTotalBytes: integer(rawMedia.maxTotalBytes, MEDIA_DEFAULTS.maxTotalBytes, 1, 100 * 1024 * 1024),
			downloadTimeoutMs: integer(rawMedia.downloadTimeoutMs, 120_000, 1000, 300_000),
			image: {
				enabled: bool(rawImage.enabled, true),
				maxBytes: integer(rawImage.maxBytes, 10 * 1024 * 1024, 1, 25 * 1024 * 1024),
			},
			voice: {
				enabled: bool(rawVoice.enabled, true),
				preferQQAsr: bool(rawVoice.preferQQAsr, true),
				maxBytes: integer(rawVoice.maxBytes, 25 * 1024 * 1024, 1, 50 * 1024 * 1024),
				...(rawStt ? { stt: normalizeStt(rawStt) } : {}),
			},
			documents: {
				enabled: bool(rawDocuments.enabled, true),
				allowExtensions: normalizeExtensions(rawDocuments.allowExtensions),
				maxTxtBytes: integer(rawDocuments.maxTxtBytes, 2 * 1024 * 1024, 1, 10 * 1024 * 1024),
				maxPdfBytes: integer(rawDocuments.maxPdfBytes, 20 * 1024 * 1024, 1, 50 * 1024 * 1024),
				maxDocBytes: integer(rawDocuments.maxDocBytes, 10 * 1024 * 1024, 1, 25 * 1024 * 1024),
				maxPdfPages: integer(rawDocuments.maxPdfPages, 100, 1, 500),
				maxExtractedChars: integer(rawDocuments.maxExtractedChars, 150_000, 1000, 300_000),
			},
		},
	};
	return config;
}

function normalizeStt(raw: Record<string, unknown>): QQMediaSttConfig {
	return {
		baseUrl: stringValue(raw.baseUrl, "").replace(/\/+$/, ""),
		apiKeyEnv: stringValue(raw.apiKeyEnv, "QQBOT_STT_API_KEY"),
		model: stringValue(raw.model, "whisper-1"),
		timeoutMs: integer(raw.timeoutMs, 60_000, 1000, 120_000),
	};
}

function normalizeExtensions(value: unknown): string[] {
	const values = Array.isArray(value) ? value : MEDIA_DEFAULTS.documents.allowExtensions;
	const allowed = new Set([".txt", ".pdf", ".doc"]);
	const normalized = values
		.filter((v): v is string => typeof v === "string")
		.map((v) => (v.startsWith(".") ? v : `.${v}`).toLowerCase())
		.filter((v) => allowed.has(v));
	return normalized.length ? [...new Set(normalized)] : [...MEDIA_DEFAULTS.documents.allowExtensions];
}

function cloneDefaults(): PiAgentQQBotConfig {
	return normalizeConfig(DEFAULTS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
	return Math.min(max, Math.max(min, n));
}

/** Returns an error string if an enabled config is missing required fields. */
export function validateEnabled(config: PiAgentQQBotConfig): string | undefined {
	if (!config.appId.trim()) return "missing appId";
	if (!config.clientSecret.trim()) return "missing clientSecret";
	if (config.allowUsers?.length !== 1 || !config.allowUsers[0]?.trim()) return "allowUsers must contain exactly one non-empty OpenID";
	if ((config.allowGroups?.length ?? 0) !== 0) return "allowGroups must be empty";
	if (config.commands.allowInGroups) return "commands.allowInGroups must be false";
	const stt = config.media.voice.stt;
	if (stt && (!stt.baseUrl || !stt.model || !stt.apiKeyEnv)) return "invalid media.voice.stt configuration";
	return undefined;
}

/** Mask an appId for safe display, e.g. 123456**** */
export function maskAppId(appId: string): string {
	if (!appId) return "(none)";
	if (appId.length <= 6) return `${appId[0] ?? ""}****`;
	return `${appId.slice(0, 6)}****`;
}
