import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

import { isWithinRoot } from "./local-paths.ts";

const nativePath = { isAbsolute, relative, resolve, sep };

export type LocalFileErrorCode =
	| "file_not_found"
	| "path_invalid"
	| "path_denied"
	| "not_regular_file"
	| "hardlink_not_allowed"
	| "empty_file"
	| "file_changed"
	| "operation_aborted";

export class LocalFileError extends Error {
	constructor(readonly code: LocalFileErrorCode, message: string, readonly cause?: unknown) {
		super(message);
		this.name = "LocalFileError";
	}
}

export interface OpenedLocalFile {
	readonly path: string;
	readonly size: number;
	readRange(offset: number, length: number): Promise<Buffer>;
	verifyUnchanged(): Promise<void>;
	close(): Promise<void>;
}

export interface OpenLocalFileOptions {
	candidate: string;
	deniedRoots: readonly string[];
	signal?: AbortSignal;
	beforeReadForTest?: () => Promise<void>;
}

export async function openVerifiedLocalFile(options: OpenLocalFileOptions): Promise<OpenedLocalFile> {
	assertNotAborted(options.signal);
	const candidate = await canonicalPath(options.candidate);
	const roots = (await Promise.all(options.deniedRoots.map((root) => realpath(root).catch(() => undefined)))).filter(
		(root): root is string => typeof root === "string",
	);
	if (roots.some((root) => isWithinRoot(candidate, root, nativePath))) {
		throw new LocalFileError("path_denied", "File is inside a denied root");
	}

	const before = await stat(candidate).catch((error: unknown) => {
		throw normalizeFsError(error);
	});
	let handle: FileHandle | undefined;
	try {
		handle = await open(candidate, constants.O_RDONLY | noFollowFlag());
		const opened = await handle.stat();
		assertRegularFile(opened);
		if (!sameIdentity(before, opened)) throw new LocalFileError("file_changed", "File changed while opening");
		if (process.platform === "linux") {
			const pinned = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
			if (pinned !== undefined && pinned !== candidate) throw new LocalFileError("file_changed", "Opened file identity changed");
		}
		return createOpenedFile(candidate, handle, opened, options);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		throw error instanceof LocalFileError ? error : normalizeFsError(error);
	}
}

function createOpenedFile(
	path: string,
	handle: FileHandle,
	initial: Stats,
	options: OpenLocalFileOptions,
): OpenedLocalFile {
	let closed = false;
	let beforeRead = options.beforeReadForTest;
	const verify = async (): Promise<void> => {
		if (closed) throw new LocalFileError("file_changed", "File handle is closed");
		assertNotAborted(options.signal);
		const currentPath = await realpath(path).catch(() => undefined);
		const current = currentPath === undefined ? undefined : await stat(currentPath).catch(() => undefined);
		const opened = await handle.stat();
		if (currentPath !== path || current === undefined || !sameIdentity(initial, current) || !sameSnapshot(initial, opened)) {
			throw new LocalFileError("file_changed", "File changed after opening");
		}
	};
	return {
		path,
		size: initial.size,
		async readRange(offset: number, length: number): Promise<Buffer> {
			if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
				throw new LocalFileError("path_invalid", "Invalid file read range");
			}
			const hook = beforeRead;
			beforeRead = undefined;
			await hook?.();
			await verify();
			const wanted = Math.min(length, Math.max(0, initial.size - offset));
			const buffer = Buffer.alloc(wanted);
			const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
			await verify();
			return bytesRead === wanted ? buffer : buffer.subarray(0, bytesRead);
		},
		verifyUnchanged: verify,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await handle.close();
		},
	};
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		throw normalizeFsError(error);
	}
}

function assertRegularFile(stats: Stats): void {
	if (!stats.isFile()) throw new LocalFileError("not_regular_file", "Target is not a regular file");
	if (stats.nlink > 1) throw new LocalFileError("hardlink_not_allowed", "Hard-linked files are not allowed");
	if (stats.size <= 0) throw new LocalFileError("empty_file", "Empty files are not supported");
}

function sameIdentity(left: Stats, right: Stats): boolean {
	if (left.ino !== 0 || right.ino !== 0) return left.dev === right.dev && left.ino === right.ino;
	return left.birthtimeMs === right.birthtimeMs && left.size === right.size;
}

function sameSnapshot(left: Stats, right: Stats): boolean {
	return sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function noFollowFlag(): number {
	return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new LocalFileError("operation_aborted", "Operation was aborted");
}

function normalizeFsError(error: unknown): LocalFileError {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT") return new LocalFileError("file_not_found", "File does not exist", error);
	return new LocalFileError("path_invalid", "Unable to access local file", error);
}
