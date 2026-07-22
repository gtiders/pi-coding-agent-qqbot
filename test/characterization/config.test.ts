import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfig } from "../../config.ts";

test("normalizes legacy and current config defaults", () => {
	const legacy = normalizeConfig({
		enabled: true,
		autoStart: false,
		appId: "test",
		clientSecret: "test",
		commands: { modelPageSize: 99 },
	});
	assert.equal(legacy.schemaVersion, 3);
	assert.equal(legacy.startup.mode, "manual");
	assert.equal(legacy.commands.modelPageSize, 6);
	assert.equal(legacy.progress.enabled, true);
	assert.equal(legacy.progress.ackAfterMs, 3000);
	assert.equal(legacy.outboundMedia.enabled, false);
	assert.equal(legacy.outboundMedia.adminsOnly, true);

	const current = normalizeConfig({
		schemaVersion: 1,
		enabled: true,
		appId: "test",
		clientSecret: "test",
		startup: { mode: "auto" },
		commands: { modelPageSize: 0 },
	});
	assert.equal(current.schemaVersion, 3);
	assert.equal(current.startup.mode, "auto");
	assert.equal(current.commands.modelPageSize, 1);
});

test("normalizes progress settings", () => {
	const config = normalizeConfig({
		enabled: true,
		appId: "test",
		clientSecret: "test",
		progress: { enabled: false, ackAfterMs: 5000 },
	});
	assert.equal(config.progress.enabled, false);
	assert.equal(config.progress.ackAfterMs, 5000);
});

test("normalizes outbound media limits", () => {
	const config = normalizeConfig({
		enabled: true,
		appId: "test",
		clientSecret: "test",
		outboundMedia: {
			enabled: true,
			allowedRoots: [" /tmp/exports ", "", "/tmp/exports"],
			maxFilesPerTurn: 99,
			maxImageBytes: 999 * 1024 * 1024,
			uploadTimeoutMs: 1,
		},
	});
	assert.equal(config.outboundMedia.enabled, true);
	assert.deepEqual(config.outboundMedia.allowedRoots, ["/tmp/exports"]);
	assert.equal(config.outboundMedia.maxFilesPerTurn, 3);
	assert.equal(config.outboundMedia.maxImageBytes, 25 * 1024 * 1024);
	assert.equal(config.outboundMedia.uploadTimeoutMs, 5000);
});
