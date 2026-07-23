import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GatewayOwnership } from "../../../src/extension/gateway-ownership.ts";
import type { LogicalLink } from "../../../src/domain/native-session-link.ts";

test("ask refusal leaves the live owner untouched and takeover transfers a matching link", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "qqbot-owner-"));
	const recordPath = join(root, "owner.json");
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const link: LogicalLink = {
		appId: "app",
		userOpenId: "USER-1",
		runtimeId: "old-runtime",
		currentSessionId: "session-1",
		generation: 3,
		linkedAt: 1,
	};
	let releases = 0;
	const oldOwner = new GatewayOwnership("app", "USER-1", async () => {
		releases++;
		return link;
	}, { recordPath, nonce: "old", handoffTimeoutMs: 1000 });
	await oldOwner.claim("takeover");

	const newOwner = new GatewayOwnership("app", "USER-1", async () => undefined, { recordPath, nonce: "new", handoffTimeoutMs: 1000 });
	await assert.rejects(newOwner.claim("ask", async () => false), /owned by local Pi process/);
	assert.equal(releases, 0);
	const claim = await newOwner.claim("takeover");
	assert.equal(releases, 1);
	assert.equal(claim.transferredLink?.currentSessionId, "session-1");
	await newOwner.release();
});

test("a dead owner record is reclaimed without contacting an endpoint", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "qqbot-owner-dead-"));
	const recordPath = join(root, "owner.json");
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const { writeFile } = await import("node:fs/promises");
	await writeFile(recordPath, JSON.stringify({ appId: "app", userOpenId: "USER-1", pid: 99, nonce: "dead", port: 1 }));
	const owner = new GatewayOwnership("app", "USER-1", async () => undefined, {
		recordPath,
		nonce: "new",
		isProcessAlive: () => false,
	});
	await owner.claim("ask");
	await owner.release();
});
