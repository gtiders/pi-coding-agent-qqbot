import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSourceBuildId } from "../../../src/extension/lifecycle.ts";

test("fingerprints every TypeScript file under src", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-build-id-"));
	try {
		await mkdir(join(root, "nested"));
		await writeFile(join(root, "index.ts"), "export const value = 1;\n");
		await writeFile(join(root, "nested", "adapter.ts"), "export const adapter = 1;\n");
		const initial = createSourceBuildId(root);
		await writeFile(join(root, "nested", "adapter.ts"), "export const adapter = 2;\n");
		const changed = createSourceBuildId(root);
		assert.notEqual(changed, initial);
		await writeFile(join(root, "ignored.test.ts"), "throw new Error('ignored');\n");
		assert.equal(createSourceBuildId(root), changed);
		assert.match(initial, /^src-[a-f0-9]{16}$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
