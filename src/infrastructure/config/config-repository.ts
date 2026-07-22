import { chmod, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import type { PiAgentQQBotConfig } from "../../application/ports.ts";
import { normalizeConfig, type LoadConfigResult } from "./normalize-config.ts";

export class ConfigRepositoryError extends Error {
	constructor(readonly code: "permission_denied" | "invalid_json" | "invalid_path" | "write_failed", message: string, readonly cause?: unknown) {
		super(message);
		this.name = "ConfigRepositoryError";
	}
}

export class FileConfigRepository {
	#writes: Promise<unknown> = Promise.resolve();

	constructor(readonly path: string) {}

	async load(): Promise<LoadConfigResult> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { config: normalizeConfig({}), missing: true };
			if (code === "EACCES" || code === "EPERM") throw new ConfigRepositoryError("permission_denied", "Cannot read config", error);
			throw new ConfigRepositoryError("invalid_path", "Cannot read config", error);
		}
		try {
			const parsed = JSON.parse(text) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new ConfigRepositoryError("invalid_json", "Config root must be an object");
			}
			return { config: normalizeConfig(parsed) };
		} catch (error) {
			if (error instanceof ConfigRepositoryError) throw error;
			throw new ConfigRepositoryError("invalid_json", "Config is not valid JSON", error);
		}
	}

	mutate(mutator: (raw: Record<string, unknown>) => Record<string, unknown>): Promise<PiAgentQQBotConfig> {
		const operation = this.#writes.then(() => this.#mutate(mutator));
		this.#writes = operation.catch(() => undefined);
		return operation;
	}

	async #mutate(mutator: (raw: Record<string, unknown>) => Record<string, unknown>): Promise<PiAgentQQBotConfig> {
		let raw: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConfigRepositoryError("invalid_json", "Config root must be an object");
			raw = parsed as Record<string, unknown>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				if (error instanceof ConfigRepositoryError) throw error;
				if (error instanceof SyntaxError) throw new ConfigRepositoryError("invalid_json", "Config is not valid JSON", error);
				throw new ConfigRepositoryError("write_failed", "Cannot update config", error);
			}
		}
		const next = mutator(structuredClone(raw));
		const directory = dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temp = `${this.path}.tmp-${randomUUID()}`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temp, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temp, this.path);
			await chmod(this.path, 0o600);
			await realpath(this.path);
			return normalizeConfig(next);
		} catch (error) {
			throw new ConfigRepositoryError("write_failed", "Cannot update config", error);
		} finally {
			await handle?.close().catch(() => undefined);
			await rm(temp, { force: true }).catch(() => undefined);
		}
	}
}
