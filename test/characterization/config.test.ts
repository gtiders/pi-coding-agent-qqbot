import assert from "node:assert/strict";
import test from "node:test";

import {
	normalizeConfig,
	UnsupportedConfigSchemaError,
	validateConfig,
} from "../../src/infrastructure/config/normalize-config.ts";

test("normalizes minimal schema 5 defaults without product-level limits", () => {
	const config = normalizeConfig({ schemaVersion: 5, appId: " app ", clientSecret: "secret", ownerOpenId: " USER-1 " });
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

test("rejects missing and obsolete schema versions", () => {
	for (const input of [{}, { schemaVersion: 4 }, { schemaVersion: "5" }]) {
		assert.throws(
			() => normalizeConfig(input),
			(error: unknown) => error instanceof UnsupportedConfigSchemaError,
		);
	}
});

test("normalizes deny lists as blacklists", () => {
	const config = normalizeConfig({
		schemaVersion: 5,
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
	assert.match(validateConfig(normalizeConfig({ schemaVersion: 5, ownerOpenId: "USER" })) ?? "", /appId/);
	assert.match(validateConfig(normalizeConfig({ schemaVersion: 5, appId: "app", ownerOpenId: "USER" })) ?? "", /clientSecret/);
	assert.match(validateConfig(normalizeConfig({ schemaVersion: 5, appId: "app", clientSecret: "secret" })) ?? "", /ownerOpenId/);
});
