import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigRepositoryError, FileConfigRepository } from "../../../src/infrastructure/config/config-repository.ts";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-config-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("ignores the old filename and returns schema 5 defaults for a missing config", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "pi-qqbot.json"), JSON.stringify({ enabled: true }));
		const path = join(root, "pi-agent-qqbot.json");
		const repository = new FileConfigRepository(path);
		const loaded = await repository.load();
		assert.equal(loaded.missing, true);
		assert.equal(loaded.config.schemaVersion, 5);
	});
});

test("rejects obsolete config schemas", async () => {
	await withRoot(async (root) => {
		const path = join(root, "pi-agent-qqbot.json");
		const repository = new FileConfigRepository(path);
		await writeFile(path, JSON.stringify({ schemaVersion: 4 }));
		await assert.rejects(
			() => repository.load(),
			(error: unknown) => error instanceof ConfigRepositoryError && error.code === "unsupported_schema",
		);
	});
});
test("classifies malformed JSON and non-object roots", async () => {
	await withRoot(async (root) => {
		const path = join(root, "pi-agent-qqbot.json");
		const repository = new FileConfigRepository(path);
		for (const invalid of ["{", "[]", "null"]) {
			await writeFile(path, invalid);
			await assert.rejects(
				() => repository.load(),
				(error: unknown) => error instanceof ConfigRepositoryError && error.code === "invalid_json",
			);
		}
	});
});
