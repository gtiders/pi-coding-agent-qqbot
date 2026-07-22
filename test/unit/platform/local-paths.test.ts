import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";

import { isWithinRoot, LocalPathError, normalizeLocalPath } from "../../../src/infrastructure/platform/local-paths.ts";

test("keeps native Windows drive and UNC paths", () => {
	assert.equal(normalizeLocalPath("C:\\Users\\tester\\a.png", "C:\\work", win32), "C:\\Users\\tester\\a.png");
	assert.equal(normalizeLocalPath("\\\\server\\share\\a.png", "C:\\work", win32), "\\\\server\\share\\a.png");
});

test("uses POSIX semantics without translating Windows-looking input", () => {
	assert.equal(normalizeLocalPath("/tmp/a.png", "/work", posix), "/tmp/a.png");
	assert.equal(normalizeLocalPath("C:\\tmp\\a.png", "/work", posix), "/work/C:\\tmp\\a.png");
});

test("strips a leading at-sign and resolves relative input", () => {
	assert.equal(normalizeLocalPath("@reports/a.txt", "/work", posix), "/work/reports/a.txt");
});

test("rejects empty and control-character paths", () => {
	assert.throws(() => normalizeLocalPath(" ", "/work", posix), (error: unknown) => error instanceof LocalPathError && error.code === "path_invalid");
	assert.throws(() => normalizeLocalPath("a\u0000b", "/work", posix), (error: unknown) => error instanceof LocalPathError && error.code === "path_invalid");
});

test("checks containment with native path semantics", () => {
	assert.equal(isWithinRoot("C:\\Root\\child\\a.txt", "C:\\Root", win32), true);
	assert.equal(isWithinRoot("D:\\Root\\a.txt", "C:\\Root", win32), false);
	assert.equal(isWithinRoot("/root/child/a.txt", "/root", posix), true);
	assert.equal(isWithinRoot("/rooted/a.txt", "/root", posix), false);
});
