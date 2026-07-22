import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function sourceFiles(directory: string): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) paths.push(...await sourceFiles(path));
		else if (entry.isFile() && path.endsWith(".ts")) paths.push(path);
	}
	return paths;
}

test("enforces domain and application import direction", async () => {
	for (const path of await sourceFiles(resolve("src", "domain"))) {
		const source = await readFile(path, "utf8");
		assert.doesNotMatch(source, /from ["']\.\.\//, path);
	}
	for (const path of await sourceFiles(resolve("src", "application"))) {
		const source = await readFile(path, "utf8");
		assert.doesNotMatch(source, /from ["'][^"']*(?:infrastructure|presentation)/, path);
	}
});
