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
	timeoutMs: number;
}

export interface QQOutboundMediaConfig {
	enabled: boolean;
	adminsOnly: boolean;
	allowPrivate: boolean;
	allowGroups: boolean;
	allowedRoots: string[];
	images: boolean;
	files: boolean;
	maxFilesPerTurn: number;
	maxImageBytes: number;
	maxFileBytes: number;
	maxTotalBytes: number;
	uploadTimeoutMs: number;
}

export interface QQMediaConfig {
	enabled: boolean;
	maxAttachments: number;
	maxTotalBytes: number;
	downloadTimeoutMs: number;
	image: {
		enabled: boolean;
		maxBytes: number;
	};
	voice: {
		enabled: boolean;
		preferQQAsr: boolean;
		maxBytes: number;
		stt?: QQMediaSttConfig;
	};
	documents: {
		enabled: boolean;
		allowExtensions: string[];
		maxTxtBytes: number;
		maxPdfBytes: number;
		maxDocBytes: number;
		maxPdfPages: number;
		maxExtractedChars: number;
	};
}

export type QQReplyFormat = "auto" | "plain";

/** Optional slow-task progress feedback sent as a passive QQ reply. */
export interface QQProgressConfig {
	/** Send one "processing" ack if the agent task is still running after ackAfterMs. */
	enabled: boolean;
	/** Delay before the slow-task ack. 0 sends as soon as the run starts. */
	ackAfterMs: number;
}

export interface QQCommandConfig {
	allowInGroups: boolean;
	buttons: boolean;
	maxListItems: number;
	modelPageSize: number;
}

export interface QQLinkConfig {
	conflictPolicy: "ask" | "takeover";
}

export interface PiAgentQQBotConfig {
	/** Persisted config schema. */
	schemaVersion: 3;
	enabled: boolean;
	appId: string;
	clientSecret: string;
	sandbox?: boolean | undefined;
	allowUsers: string[];
	allowGroups: string[];
	replyPrefix?: string | undefined;
	maxQueueSize?: number | undefined;
	sendBusyNotice?: boolean | undefined;
	commands: QQCommandConfig;
	link: QQLinkConfig;
	/** Include a compact execution summary after the final answer. */
	showProcess?: boolean | undefined;
	/** Prefer native QQ Markdown with a safe plain-text fallback, or force plain text. */
	replyFormat: QQReplyFormat;
	/** Slow-task progress ack inside the passive-reply budget. */
	progress: QQProgressConfig;
	/** Local computer -> current QQ conversation rich-media delivery policy. */
	outboundMedia: QQOutboundMediaConfig;
	media: QQMediaConfig;
	debug?: boolean | undefined;
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
			note?: string | undefined;
			errorCode?: string | undefined;
	  }
	| {
			kind: "voice";
			filename: string;
			status: AttachmentStatus;
			transcript?: string | undefined;
			source?: "qq-asr" | "stt" | undefined;
			note?: string | undefined;
			errorCode?: string | undefined;
	  }
	| {
			kind: "document";
			filename: string;
			status: AttachmentStatus;
			extractedText?: string | undefined;
			truncated?: boolean | undefined;
			note?: string | undefined;
			errorCode?: string | undefined;
	  }
	| {
			kind: "unsupported";
			filename: string;
			status: "rejected";
			reason: string;
			errorCode: string;
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

export type QQAttachmentEventKind = "attachment_start" | "attachment_progress" | "attachment_end" | "attachment_rejected";
export type QQOutboundEventKind = "outbound_start" | "outbound_uploaded" | "outbound_sent" | "outbound_failed";

export interface QQMediaUploadResult {
	fileInfo: string;
	fileUuid?: string | undefined;
	ttl: number;
}

export interface QQOutboundDeliveryRecord {
	filename: string;
	kind: "image" | "file";
	bytes: number;
	status: "sent" | "failed" | "unknown";
	errorCode?: string | undefined;
	note?: string | undefined;
}

export interface QQReplyPort {
	sendText(target: QQReplyTarget, text: string, seq: number): Promise<void>;
}
