import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileConfigRepository } from "../../../src/infrastructure/config/config-repository.ts";

test("ignores the old filename and serializes atomic mutations", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-config-"));
	try {
		await writeFile(join(root, "pi-qqbot.json"), JSON.stringify({ enabled: true }));
		const path = join(root, "pi-agent-qqbot.json");
		const repository = new FileConfigRepository(path);
		assert.equal((await repository.load()).missing, true);
		await Promise.all(Array.from({ length: 40 }, (_, index) => repository.mutate((raw) => ({
			...raw,
			unknownField: "preserved",
			allowUsers: [...(Array.isArray(raw.allowUsers) ? raw.allowUsers : []), `USER-${index}`],
		}))));
		const raw = JSON.parse(await readFile(path, "utf8")) as { allowUsers: string[]; unknownField: string };
		assert.equal(raw.allowUsers.length, 40);
		assert.equal(new Set(raw.allowUsers).size, 40);
		assert.equal(raw.unknownField, "preserved");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
