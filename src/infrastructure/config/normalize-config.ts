/** Config loading and schema migration for pi-agent-qqbot. */

import { homedir } from "node:os";
import { extname, join } from "node:path";

import type {
	PiAgentQQBotConfig,
	QQMediaKind,
	QQMediaSttConfig,
} from "../../application/ports.ts";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-agent-qqbot.json");

const MEDIA_KINDS = new Set<QQMediaKind>(["image", "video", "voice", "file"]);

const DEFAULTS: PiAgentQQBotConfig = {
	schemaVersion: 5,
	appId: "",
	clientSecret: "",
	sandbox: true,
	ownerOpenId: "",
	link: { conflictPolicy: "ask" },
	inboundMedia: { deniedKinds: [], deniedExtensions: [] },
	outboundMedia: { enabled: false, deniedRoots: [], deniedKinds: [], deniedExtensions: [] },
	logging: { level: "info" },
};

export interface LoadConfigResult {
	config: PiAgentQQBotConfig;
	missing?: boolean;
}

/** Normalize schema 5 and migrate meaningful schema 4 policy without carrying obsolete limits. */
export function normalizeConfig(parsed: unknown): PiAgentQQBotConfig {
	const raw = isRecord(parsed) ? parsed : {};
	const rawLink = record(raw.link);
	const rawInbound = record(raw.inboundMedia);
	const rawOutbound = record(raw.outboundMedia);
	const legacyMedia = record(raw.media);
	const legacyVoice = record(legacyMedia.voice);
	const rawStt = recordOrUndefined(rawInbound.stt) ?? recordOrUndefined(legacyVoice.stt);
	const legacyOwner = stringArray(raw.allowUsers).find((value) => value.trim()) ?? "";

	const inboundDeniedKinds = normalizeKinds(rawInbound.deniedKinds);
	if (raw.schemaVersion !== 5) {
		const legacyImage = record(legacyMedia.image);
		const legacyDocuments = record(legacyMedia.documents);
		if (legacyMedia.enabled === false || legacyImage.enabled === false) inboundDeniedKinds.push("image");
		if (legacyMedia.enabled === false || legacyVoice.enabled === false) inboundDeniedKinds.push("voice");
		if (legacyMedia.enabled === false || legacyDocuments.enabled === false) inboundDeniedKinds.push("file");
	}

	const outboundDeniedKinds = normalizeKinds(rawOutbound.deniedKinds);
	if (raw.schemaVersion !== 5) {
		if (rawOutbound.images === false) outboundDeniedKinds.push("image");
		if (rawOutbound.files === false) outboundDeniedKinds.push("file");
	}

	return {
		schemaVersion: 5,
		appId: stringValue(raw.appId, "").trim(),
		clientSecret: stringValue(raw.clientSecret, ""),
		sandbox: bool(raw.sandbox, DEFAULTS.sandbox),
		ownerOpenId: stringValue(raw.ownerOpenId, legacyOwner).trim(),
		link: {
			conflictPolicy: rawLink.conflictPolicy === "takeover" ? "takeover" : "ask",
		},
		inboundMedia: {
			deniedKinds: unique(inboundDeniedKinds),
			deniedExtensions: normalizeExtensions(rawInbound.deniedExtensions),
			...(rawStt ? { stt: normalizeStt(rawStt) } : {}),
		},
		outboundMedia: {
			enabled: bool(rawOutbound.enabled, DEFAULTS.outboundMedia.enabled),
			deniedRoots: normalizeStrings(rawOutbound.deniedRoots),
			deniedKinds: unique(outboundDeniedKinds),
			deniedExtensions: normalizeExtensions(rawOutbound.deniedExtensions),
		},
		logging: {
			level: normalizeLogLevel(record(raw.logging).level, raw.debug),
		},
	};
}

function normalizeStt(raw: Record<string, unknown>): QQMediaSttConfig {
	return {
		baseUrl: stringValue(raw.baseUrl, "").replace(/\/+$/, ""),
		apiKeyEnv: stringValue(raw.apiKeyEnv, "QQBOT_STT_API_KEY"),
		model: stringValue(raw.model, "whisper-1"),
	};
}

function normalizeKinds(value: unknown): QQMediaKind[] {
	return stringArray(value)
		.map((item) => item.trim().toLowerCase())
		.filter((item): item is QQMediaKind => MEDIA_KINDS.has(item as QQMediaKind));
}

function normalizeExtensions(value: unknown): string[] {
	return unique(stringArray(value).map((item) => {
		const trimmed = item.trim().toLowerCase();
		if (!trimmed) return "";
		const extension = trimmed.startsWith(".") ? trimmed : extname(trimmed) || `.${trimmed}`;
		return /^\.[a-z0-9][a-z0-9._+-]{0,31}$/i.test(extension) ? extension : "";
	})).filter(Boolean);
}

function normalizeStrings(value: unknown): string[] {
	return unique(stringArray(value).map((item) => item.trim()).filter(Boolean));
}

function normalizeLogLevel(value: unknown, legacyDebug: unknown): "error" | "info" | "debug" {
	if (value === "error" || value === "debug") return value;
	if (legacyDebug === true) return "debug";
	return "info";
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function validateConfig(config: PiAgentQQBotConfig): string | undefined {
	if (!config.appId) return "missing appId";
	if (!config.clientSecret.trim()) return "missing clientSecret";
	if (!config.ownerOpenId) return "missing ownerOpenId";
	const stt = config.inboundMedia.stt;
	if (stt && (!stt.baseUrl || !stt.model || !stt.apiKeyEnv)) return "invalid inboundMedia.stt configuration";
	return undefined;
}

/** Mask an appId for safe display, e.g. 123456**** */
export function maskAppId(appId: string): string {
	if (!appId) return "(none)";
	if (appId.length <= 6) return `${appId[0] ?? ""}****`;
	return `${appId.slice(0, 6)}****`;
}
