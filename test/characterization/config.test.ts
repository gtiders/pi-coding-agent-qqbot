import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfig, validateConfig } from "../../src/infrastructure/config/normalize-config.ts";

test("normalizes minimal schema 5 defaults without product-level limits", () => {
	const config = normalizeConfig({ appId: " app ", clientSecret: "secret", ownerOpenId: " USER-1 " });
	assert.equal(config.schemaVersion, 5);
	assert.equal(config.appId, "app");
	assert.equal(config.ownerOpenId, "USER-1");
	assert.deepEqual(config.inboundMedia, { deniedKinds: [], deniedExtensions: [] });
	assert.deepEqual(config.outboundMedia, {
		enabled: false,
		deniedRoots: [],
		deniedKinds: [],
		deniedExtensions: [],
	});
	assert.equal("maxQueueSize" in config, false);
	assert.equal("commands" in config, false);
	assert.equal("media" in config, false);
	assert.equal(validateConfig(config), undefined);
});

test("migrates meaningful schema 4 policy and discards obsolete limits", () => {
	const config = normalizeConfig({
		schemaVersion: 4,
		appId: "app",
		clientSecret: "secret",
		allowUsers: ["USER-1"],
		debug: true,
		media: {
			image: { enabled: false, maxBytes: 1 },
			voice: { enabled: true, stt: { baseUrl: "https://stt.example/v1/", apiKeyEnv: "STT_KEY", model: "whisper", timeoutMs: 1 } },
			documents: { enabled: true, allowExtensions: [".txt"], maxPdfPages: 1 },
			maxAttachments: 1,
		},
		outboundMedia: {
			enabled: true,
			images: false,
			files: true,
			deniedRoots: [" C:/private ", "C:/private"],
			maxFilesPerTurn: 1,
		},
	});
	assert.equal(config.ownerOpenId, "USER-1");
	assert.deepEqual(config.inboundMedia.deniedKinds, ["image"]);
	assert.deepEqual(config.outboundMedia.deniedKinds, ["image"]);
	assert.deepEqual(config.outboundMedia.deniedRoots, ["C:/private"]);
	assert.deepEqual(config.inboundMedia.stt, { baseUrl: "https://stt.example/v1", apiKeyEnv: "STT_KEY", model: "whisper" });
	assert.equal(config.logging.level, "debug");
	assert.equal("maxFilesPerTurn" in config.outboundMedia, false);
});

test("normalizes deny lists as blacklists", () => {
	const config = normalizeConfig({
		appId: "app",
		clientSecret: "secret",
		ownerOpenId: "USER-1",
		inboundMedia: { deniedKinds: ["voice", "VOICE", "invalid"], deniedExtensions: ["exe", ".ZIP", "", "bad/path"] },
		outboundMedia: { enabled: true, deniedKinds: ["video"], deniedExtensions: [".key", "key"] },
		logging: { level: "error" },
	});
	assert.deepEqual(config.inboundMedia.deniedKinds, ["voice"]);
	assert.deepEqual(config.inboundMedia.deniedExtensions, [".exe", ".zip"]);
	assert.deepEqual(config.outboundMedia.deniedKinds, ["video"]);
	assert.deepEqual(config.outboundMedia.deniedExtensions, [".key"]);
	assert.equal(config.logging.level, "error");
});

test("requires credentials and exactly one owner identity", () => {
	assert.match(validateConfig(normalizeConfig({ ownerOpenId: "USER" })) ?? "", /appId/);
	assert.match(validateConfig(normalizeConfig({ appId: "app", ownerOpenId: "USER" })) ?? "", /clientSecret/);
	assert.match(validateConfig(normalizeConfig({ appId: "app", clientSecret: "secret" })) ?? "", /ownerOpenId/);
});
