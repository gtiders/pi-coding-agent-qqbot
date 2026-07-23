import assert from "node:assert/strict";
import { link, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalFileError, openVerifiedLocalFile } from "../../../src/infrastructure/platform/opened-file-identity.ts";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-file-test-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("opens and reads a regular file when no roots are denied", async () => {
	await withRoot(async (root) => {
		const path = join(root, "report.txt");
		await writeFile(path, "report");
		const opened = await openVerifiedLocalFile({ candidate: path, deniedRoots: [] });
		try {
			assert.equal((await opened.read()).toString("utf8"), "report");
			assert.equal(opened.size, 6);
			await opened.close();
			await opened.close();
		} finally {
			await opened.close();
		}
	});
});

test("rejects directories", async () => {
	await withRoot(async (root) => {
		await assert.rejects(
			() => openVerifiedLocalFile({ candidate: root, deniedRoots: [] }),
			(error: unknown) => error instanceof LocalFileError && error.code === "not_regular_file",
		);
	});
});

test("honors abort before opening and before reading", async () => {
	await withRoot(async (root) => {
		const path = join(root, "report.txt");
		await writeFile(path, "report");
		const beforeOpen = new AbortController();
		beforeOpen.abort();
		await assert.rejects(
			() => openVerifiedLocalFile({ candidate: path, deniedRoots: [], signal: beforeOpen.signal }),
			(error: unknown) => error instanceof LocalFileError && error.code === "operation_aborted",
		);

		const beforeRead = new AbortController();
		const opened = await openVerifiedLocalFile({
			candidate: path,
			deniedRoots: [],
			signal: beforeRead.signal,
			beforeReadForTest: async () => beforeRead.abort(),
		});
		try {
			await assert.rejects(
				() => opened.read(),
				(error: unknown) => error instanceof LocalFileError && error.code === "operation_aborted",
			);
		} finally {
			await opened.close();
		}
	});
});

test("rejects files inside a denied root", async () => {
	await withRoot(async (root) => {
		const path = join(root, "secret.txt");
		await writeFile(path, "secret");
		await assert.rejects(
			() => openVerifiedLocalFile({ candidate: path, deniedRoots: [root] }),
			(error: unknown) => error instanceof LocalFileError && error.code === "path_denied",
		);
	});
});

test("allows files outside denied roots", async () => {
	await withRoot(async (root) => {
		const denied = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-denied-"));
		try {
			const path = join(root, "report.txt");
			await writeFile(path, "report");
			const opened = await openVerifiedLocalFile({ candidate: path, deniedRoots: [denied] });
			await opened.close();
		} finally {
			await rm(denied, { recursive: true, force: true });
		}
	});
});

test("rejects empty files", async () => {
	await withRoot(async (root) => {
		const path = join(root, "empty.txt");
		await writeFile(path, "");
		await assert.rejects(
			() => openVerifiedLocalFile({ candidate: path, deniedRoots: [] }),
			(error: unknown) => error instanceof LocalFileError && error.code === "empty_file",
		);
	});
});

test("rejects hard-linked files", async () => {
	await withRoot(async (root) => {
		const path = join(root, "report.txt");
		await writeFile(path, "report");
		await link(path, join(root, "report-link.txt"));
		await assert.rejects(
			() => openVerifiedLocalFile({ candidate: path, deniedRoots: [] }),
			(error: unknown) => error instanceof LocalFileError && error.code === "hardlink_not_allowed",
		);
	});
});

test("rejects symlinks that resolve inside denied roots", async (context) => {
	await withRoot(async (root) => {
		const outside = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-outside-"));
		try {
			const target = join(outside, "secret.txt");
			await writeFile(target, "secret");
			const alias = join(root, "alias.txt");
			try {
				await symlink(target, alias, "file");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EPERM") {
					context.skip("file symlinks require Windows Developer Mode or elevated privileges");
					return;
				}
				throw error;
			}
			await assert.rejects(
				() => openVerifiedLocalFile({ candidate: alias, deniedRoots: [outside] }),
				(error: unknown) => error instanceof LocalFileError && error.code === "path_denied",
			);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test("rejects a Windows junction that resolves inside denied roots", async (context) => {
	if (process.platform !== "win32") {
		context.skip("Windows junction coverage");
		return;
	}
	await withRoot(async (root) => {
		const outside = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-outside-"));
		try {
			await writeFile(join(outside, "secret.txt"), "secret");
			const junction = join(root, "outside-junction");
			await symlink(outside, junction, "junction");
			await assert.rejects(
				() => openVerifiedLocalFile({ candidate: join(junction, "secret.txt"), deniedRoots: [outside] }),
				(error: unknown) => error instanceof LocalFileError && error.code === "path_denied",
			);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test("detects pathname replacement after opening", async (context) => {
	await withRoot(async (root) => {
		const path = join(root, "report.txt");
		const original = join(root, "original.txt");
		await writeFile(path, "original");
		const opened = await openVerifiedLocalFile({
			candidate: path,
			deniedRoots: [],
			beforeReadForTest: async () => {
				try {
					await rename(path, original);
					await writeFile(path, "replacement");
				} catch (error) {
					if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
						context.skip("this filesystem does not allow replacing an opened pathname");
						return;
					}
					throw error;
				}
			},
		});
		try {
			await assert.rejects(
				() => opened.read(),
				(error: unknown) => error instanceof LocalFileError && error.code === "file_changed",
			);
		} finally {
			await opened.close();
		}
	});
});
