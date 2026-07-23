import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfig, validateEnabled } from "../../src/infrastructure/config/normalize-config";

test("normalizes schema 4 defaults and ignores removed compatibility fields", () => {
	const defaults = normalizeConfig({
		enabled: true,
		autoStart: false,
		allowCommands: false,
		appId: "test",
		clientSecret: "test",
		commands: { modelPageSize: 99 },
	});
	assert.equal(defaults.schemaVersion, 4);
	assert.equal("startup" in defaults, false);
	assert.equal("sessions" in defaults, false);
	assert.equal(defaults.commands.modelPageSize, 6);
	assert.equal(defaults.progress.enabled, true);
	assert.equal(defaults.progress.ackAfterMs, 3000);
	assert.equal(defaults.outboundMedia.enabled, false);
	assert.equal(defaults.outboundMedia.adminsOnly, true);
	assert.deepEqual(defaults.outboundMedia.deniedRoots, []);
	assert.equal(defaults.link.conflictPolicy, "ask");

	const current = normalizeConfig({
		schemaVersion: 1,
		enabled: true,
		appId: "test",
		clientSecret: "test",
		startup: { mode: "auto" },
		commands: { modelPageSize: 0 },
	});
	assert.equal(current.schemaVersion, 4);
	assert.equal("startup" in current, false);
	assert.equal(current.commands.modelPageSize, 1);
});

test("requires exactly one C2C user and rejects group configuration", () => {
	const valid = normalizeConfig({
		enabled: true,
		appId: "test",
		clientSecret: "secret",
		allowUsers: ["USER-1"],
		allowGroups: [],
		commands: { allowInGroups: false },
		link: { conflictPolicy: "takeover" },
	});
	assert.equal(validateEnabled(valid), undefined);
	assert.equal(valid.link.conflictPolicy, "takeover");
	assert.match(validateEnabled(normalizeConfig({ ...valid, allowUsers: [] })) ?? "", /exactly one/);
	assert.match(validateEnabled(normalizeConfig({ ...valid, allowUsers: ["A", "B"] })) ?? "", /exactly one/);
	assert.match(validateEnabled(normalizeConfig({ ...valid, allowGroups: ["GROUP"] })) ?? "", /allowGroups/);
	assert.match(validateEnabled(normalizeConfig({ ...valid, commands: { ...valid.commands, allowInGroups: true } })) ?? "", /allowInGroups/);
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
			deniedRoots: [" /private/keys ", "", "/private/keys"],
			allowedRoots: ["/legacy/is/ignored"],
			maxFilesPerTurn: 99,
			maxImageBytes: 999 * 1024 * 1024,
			uploadTimeoutMs: 1,
		},
	});
	assert.equal(config.outboundMedia.enabled, true);
	assert.deepEqual(config.outboundMedia.deniedRoots, ["/private/keys"]);
	assert.equal("allowedRoots" in config.outboundMedia, false);
	assert.equal(config.outboundMedia.maxFilesPerTurn, 3);
	assert.equal(config.outboundMedia.maxImageBytes, 25 * 1024 * 1024);
	assert.equal(config.outboundMedia.uploadTimeoutMs, 5000);
});
