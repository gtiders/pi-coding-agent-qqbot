/** Shared types for the pi-agent-qqbot extension. */

/** Pi SDK-compatible inline image payload. */
export interface QQImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface QQMediaSttConfig {
	baseUrl: string;
	/** Name of the environment variable containing the API key. */
	apiKeyEnv: string;
	model: string;
}

export type QQMediaKind = "image" | "video" | "voice" | "file";

export interface QQMediaDenyPolicy {
	/** Media kinds blocked by user policy. Empty means no kind is blocked. */
	deniedKinds: QQMediaKind[];
	/** Lower-case filename extensions blocked by user policy. Empty means no extension is blocked. */
	deniedExtensions: string[];
}

export interface QQOutboundMediaConfig {
	enabled: boolean;
	/** Canonical directory roots that may never be sent to QQ. Empty allows every readable path. */
	deniedRoots: string[];
	deniedKinds: QQMediaKind[];
	deniedExtensions: string[];
}

export interface QQInboundMediaConfig extends QQMediaDenyPolicy {
	stt?: QQMediaSttConfig;
}

export interface QQLinkConfig {
	conflictPolicy: "ask" | "takeover";
}

export interface PiAgentQQBotConfig {
	/** Persisted config schema. */
	schemaVersion: 5;
	appId: string;
	clientSecret: string;
	sandbox: boolean;
	ownerOpenId: string;
	link: QQLinkConfig;
	inboundMedia: QQInboundMediaConfig;
	/** Local computer -> current QQ conversation rich-media delivery policy. */
	outboundMedia: QQOutboundMediaConfig;
	logging: { level: "error" | "info" | "debug" };
}

export interface QQAttachment {
	contentType: string;
	filename: string;
	size?: number | undefined;
	width?: number | undefined;
	height?: number | undefined;
	url?: string | undefined;
	voiceWavUrl?: string | undefined;
	asrReferText?: string | undefined;
}

/** A normalized inbound QQ message. */
export interface QQInboundMessage {
	id: string; // platform message id, required for passive reply
	type: "private" | "group";
	text: string;
	userOpenId: string; // user_openid (private) or member_openid (group)
	groupOpenId?: string | undefined;
	attachments: QQAttachment[];
	raw: unknown;
	receivedAt: number;
	/** Internal: locally simulated message (/qqbot-fake). Reply is not sent to QQ. */
	fake?: boolean | undefined;
}

export type AttachmentStatus = "ready" | "rejected" | "failed";

export type PreparedAttachment =
	| {
			kind: "image";
			filename: string;
			status: AttachmentStatus;
			mimeType?: string | undefined;
			localPath?: string | undefined;
			note?: string | undefined;
			errorCode?: string | undefined;
	  }
	| {
			kind: "voice";
			filename: string;
			status: AttachmentStatus;
			transcript?: string | undefined;
			source?: "qq-asr" | "stt" | undefined;
			mimeType?: string | undefined;
			localPath?: string | undefined;
			note?: string | undefined;
			errorCode?: string | undefined;
	  }
	| {
			kind: "document";
			filename: string;
			status: AttachmentStatus;
			extractedText?: string | undefined;
			localPath?: string | undefined;
			truncated?: boolean | undefined;
			note?: string | undefined;
			errorCode?: string | undefined;
	  }
	| {
			kind: "file";
			filename: string;
			status: AttachmentStatus;
			mimeType?: string | undefined;
			localPath?: string | undefined;
			note?: string | undefined;
			errorCode?: string | undefined;
	  };

export interface PreparedQQMessage {
	prompt: string;
	images: QQImageContent[];
	resources: PreparedAttachment[];
	cleanup(): Promise<void>;
}

/**
 * Reply target. QQ replies must be sent as passive messages that reference the
 * originating msg_id (and msg_seq), inside a time window (C2C 60min, group 5min).
 */
export interface QQReplyTarget {
	type: "private" | "group";
	userOpenId: string;
	groupOpenId?: string | undefined;
	msgId: string; // original inbound message id
	createdAt: number; // to reason about the passive-reply window
}

export interface QQKeyboardButton {
	id: string;
	render_data: {
		label: string;
		visited_label: string;
		style: 0 | 1;
	};
	action: {
		type: 2;
		permission: { type: 2 };
		data: string;
		reply: boolean;
		enter: boolean;
		unsupport_tips: string;
	};
}

export interface QQKeyboard {
	content: {
		rows: Array<{ buttons: QQKeyboardButton[] }>;
	};
}

export type ConnectionState =
	| "disabled"
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

export interface QQMediaUploadResult {
	fileInfo: string;
	fileUuid?: string | undefined;
	ttl: number;
}

export interface QQOutboundDeliveryRecord {
	filename: string;
	kind: QQMediaKind;
	bytes: number;
	status: "sent" | "failed" | "unknown";
	errorCode?: string | undefined;
	note?: string | undefined;
}

export interface QQReplyPort {
	sendText(target: QQReplyTarget, text: string, seq: number): Promise<void>;
}
