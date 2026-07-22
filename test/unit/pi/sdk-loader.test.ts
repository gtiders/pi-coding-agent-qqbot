import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { resolveSdkUrl } from "../../../src/infrastructure/pi/sdk-loader.ts";

async function withFakeSdk(run: (entry: string, launcher: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-sdk-"));
	try {
		const dist = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
		await mkdir(dist, { recursive: true });
		const entry = join(dist, "index.js");
		const launcher = join(dist, "cli.js");
		await writeFile(entry, "export const getAgentDir = () => '';\n");
		await writeFile(launcher, "import './index.js';\n");
		await run(entry, launcher);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("resolves a verified SDK module before launcher fallback", async () => {
	await withFakeSdk(async (entry) => {
		const resolved = await resolveSdkUrl({
			resolveModule: async () => entry,
			launcher: join(tmpdir(), "missing", "cli.js"),
		});
		assert.equal(resolved.href, pathToFileURL(entry).href);
	});
});

test("falls back to a verified Pi launcher installation", async () => {
	await withFakeSdk(async (entry, launcher) => {
		const resolved = await resolveSdkUrl({
			resolveModule: async () => {
				throw new Error("module resolution unavailable");
			},
			launcher,
		});
		assert.equal(resolved.href, pathToFileURL(entry).href);
	});
});

test("rejects unverified SDK candidates without exposing candidate paths", async () => {
	await assert.rejects(
		() => resolveSdkUrl({ explicit: new URL("file:///definitely-missing/pi-sdk.js"), resolveModule: async () => "/also/missing.js" }),
		(error: unknown) => error instanceof Error && /explicit, module/.test(error.message) && !error.message.includes("definitely-missing"),
	);
});
