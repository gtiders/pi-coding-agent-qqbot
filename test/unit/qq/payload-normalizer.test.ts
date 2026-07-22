import assert from "node:assert/strict";
import test from "node:test";

import {
	normalizeAttachments,
	normalizeInboundPayload,
} from "../../../src/infrastructure/qq/payload-normalizer.ts";

test("normalizes credential-free C2C payloads", () => {
	const raw = {
		id: "private-message",
		content: " hello ",
		author: { user_openid: "USER" },
		attachments: [{
			content_type: "image/png",
			url: "//example.test/image",
			size: 10,
			width: 20,
			height: 30,
		}],
	};
	assert.deepEqual(normalizeInboundPayload("C2C_MESSAGE_CREATE", raw, 123), {
		id: "private-message",
		type: "private",
		text: "hello",
		userOpenId: "USER",
		attachments: [{
			contentType: "image/png",
			filename: "image-1",
			size: 10,
			width: 20,
			height: 30,
			url: "https://example.test/image",
		}],
		raw,
		receivedAt: 123,
	});
});

test("normalizes credential-free group payloads", () => {
	const raw = {
		id: "group-message",
		content: " @bot question ",
		group_openid: "GROUP",
		author: { member_openid: "MEMBER" },
		attachments: [{
			content_type: "voice",
			voice_wav_url: "//example.test/voice.wav",
			asr_refer_text: " transcript ",
		}],
	};
	assert.deepEqual(normalizeInboundPayload("GROUP_AT_MESSAGE_CREATE", raw, 456), {
		id: "group-message",
		type: "group",
		text: "@bot question",
		userOpenId: "MEMBER",
		groupOpenId: "GROUP",
		attachments: [{
			contentType: "voice",
			filename: "voice-1",
			voiceWavUrl: "https://example.test/voice.wav",
			asrReferText: "transcript",
		}],
		raw,
		receivedAt: 456,
	});
});

test("rejects unsupported or incomplete events and ignores malformed attachments", () => {
	assert.equal(normalizeInboundPayload("OTHER", { id: "message" }), undefined);
	assert.equal(normalizeInboundPayload("C2C_MESSAGE_CREATE", { id: "message", author: {} }), undefined);
	assert.equal(normalizeInboundPayload("GROUP_AT_MESSAGE_CREATE", { id: "message" }), undefined);
	assert.deepEqual(normalizeAttachments([
		null,
		"invalid",
		{ content_type: "application/pdf", filename: " file.pdf ", size: -1, width: Number.NaN },
	]), [{ contentType: "application/pdf", filename: "file.pdf" }]);
});
