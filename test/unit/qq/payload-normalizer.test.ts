import assert from "node:assert/strict";
import test from "node:test";

import { normalizeInboundPayload } from "../../../src/infrastructure/qq/payload-normalizer.ts";

test("normalizes private and group QQ payloads", () => {
	const privateMessage = normalizeInboundPayload("C2C_MESSAGE_CREATE", {
		id: "1",
		content: " hello ",
		author: { user_openid: "USER" },
		attachments: [{ content_type: "image/png", url: "//example.test/image", size: 10 }],
	}, 123);
	assert.equal(privateMessage?.type, "private");
	assert.equal(privateMessage?.text, "hello");
	assert.equal(privateMessage?.attachments[0]?.url, "https://example.test/image");
	assert.equal(privateMessage?.receivedAt, 123);

	const groupMessage = normalizeInboundPayload("GROUP_AT_MESSAGE_CREATE", {
		id: "2",
		group_openid: "GROUP",
		author: { member_openid: "MEMBER" },
	});
	assert.equal(groupMessage?.type, "group");
	assert.equal(groupMessage?.groupOpenId, "GROUP");
});
