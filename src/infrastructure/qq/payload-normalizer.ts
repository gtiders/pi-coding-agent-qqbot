import type { QQAttachment, QQInboundMessage } from "../../application/ports.ts";

export function normalizeInboundPayload(event: string, value: unknown, now = Date.now()): QQInboundMessage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as Record<string, unknown>;
	if (typeof data.id !== "string") return undefined;
	const author = data.author && typeof data.author === "object" ? data.author as Record<string, unknown> : {};
	const text = typeof data.content === "string" ? data.content.trim() : "";
	const attachments = normalizeAttachments(data.attachments);
	if (event === "C2C_MESSAGE_CREATE" && typeof author.user_openid === "string" && author.user_openid) {
		return { id: data.id, type: "private", text, userOpenId: author.user_openid, attachments, raw: value, receivedAt: now };
	}
	if (event === "GROUP_AT_MESSAGE_CREATE" && typeof data.group_openid === "string") {
		return {
			id: data.id,
			type: "group",
			text,
			userOpenId: typeof author.member_openid === "string" ? author.member_openid : "",
			groupOpenId: data.group_openid,
			attachments,
			raw: value,
			receivedAt: now,
		};
	}
	return undefined;
}

export function normalizeAttachments(value: unknown): QQAttachment[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item, index) => {
		if (!item || typeof item !== "object") return [];
		const raw = item as Record<string, unknown>;
		const contentType = text(raw.content_type);
		const attachment: QQAttachment = {
			contentType,
			filename: text(raw.filename) || defaultFilename(contentType, index + 1),
		};
		for (const key of ["size", "width", "height"] as const) {
			const number = raw[key];
			if (typeof number === "number" && Number.isFinite(number) && number >= 0) attachment[key] = number;
		}
		const url = qqUrl(raw.url);
		const voiceWavUrl = qqUrl(raw.voice_wav_url);
		const asrReferText = text(raw.asr_refer_text);
		return [{ ...attachment, ...(url ? { url } : {}), ...(voiceWavUrl ? { voiceWavUrl } : {}), ...(asrReferText ? { asrReferText } : {}) }];
	});
}

function qqUrl(value: unknown): string | undefined {
	const valueText = text(value);
	return valueText ? (valueText.startsWith("//") ? `https:${valueText}` : valueText) : undefined;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function defaultFilename(contentType: string, index: number): string {
	if (contentType.startsWith("image/")) return `image-${index}`;
	if (contentType === "voice" || contentType.startsWith("audio/")) return `voice-${index}`;
	return `attachment-${index}`;
}
