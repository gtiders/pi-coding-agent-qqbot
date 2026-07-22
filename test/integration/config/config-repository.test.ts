import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigRepositoryError, FileConfigRepository } from "../../../src/infrastructure/config/config-repository.ts";
import { addAccessUser, removeAccessUser } from "../../../src/infrastructure/config/normalize-config.ts";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-config-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("ignores the old filename and serializes atomic mutations", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "pi-qqbot.json"), JSON.stringify({ enabled: true }));
		const path = join(root, "pi-agent-qqbot.json");
		const repository = new FileConfigRepository(path);
		assert.equal((await repository.load()).missing, true);
		await Promise.all(Array.from({ length: 100 }, (_, index) => repository.mutate((raw) => ({
			...raw,
			unknownField: { preserved: true },
			allowUsers: [...(Array.isArray(raw.allowUsers) ? raw.allowUsers : []), `USER-${index}`],
		}))));
		const raw = JSON.parse(await readFile(path, "utf8")) as { allowUsers: string[]; unknownField: { preserved: boolean } };
		assert.equal(raw.allowUsers.length, 100);
		assert.equal(new Set(raw.allowUsers).size, 100);
		assert.deepEqual(raw.unknownField, { preserved: true });
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

test("preserves unknown fields while adding and removing access", async () => {
	await withRoot(async (root) => {
		const path = join(root, "pi-agent-qqbot.json");
		await writeFile(path, JSON.stringify({
			enabled: true,
			unknownField: { nested: [1, 2, 3] },
			commands: { enabled: true, customField: "keep", admins: [] },
		}));
		const repository = new FileConfigRepository(path);
		await repository.mutate((raw) => addAccessUser(raw, "USER-A", "admin"));
		await repository.mutate((raw) => removeAccessUser(raw, "USER-A"));
		const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		assert.deepEqual(raw.unknownField, { nested: [1, 2, 3] });
		assert.equal((raw.commands as Record<string, unknown>).customField, "keep");
		assert.deepEqual(raw.allowUsers, []);
		assert.deepEqual((raw.commands as Record<string, unknown>).admins, []);
	});
});
