import { createHash, randomUUID } from "node:crypto";
import { createServer, connect, type Server, type Socket } from "node:net";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { LogicalLink } from "../domain/native-session-link.ts";

interface OwnerRecord {
	appId: string;
	userOpenId: string;
	pid: number;
	nonce: string;
	port: number;
}

interface HandoffRequest {
	action: "release";
	appId: string;
	userOpenId: string;
	nonce: string;
}

interface HandoffResponse {
	ok: boolean;
	error?: string;
	link?: LogicalLink;
}

export interface OwnershipClaim {
	transferredLink?: LogicalLink | undefined;
}

export interface GatewayOwnershipOptions {
	recordPath?: string;
	pid?: number;
	nonce?: string;
	handoffTimeoutMs?: number;
	isProcessAlive?: (pid: number) => boolean;
}

export class GatewayOwnership {
	private readonly recordPath: string;
	private readonly pid: number;
	private readonly nonce: string;
	private readonly handoffTimeoutMs: number;
	private readonly isProcessAlive: (pid: number) => boolean;
	private server: Server | undefined;
	private record: OwnerRecord | undefined;

	constructor(
		private readonly appId: string,
		private readonly userOpenId: string,
		private readonly onRelease: () => Promise<LogicalLink | undefined>,
		options: GatewayOwnershipOptions = {},
	) {
		this.recordPath = options.recordPath ?? ownerRecordPath(appId);
		this.pid = options.pid ?? process.pid;
		this.nonce = options.nonce ?? randomUUID();
		this.handoffTimeoutMs = options.handoffTimeoutMs ?? 3000;
		this.isProcessAlive = options.isProcessAlive ?? processAlive;
	}

	async claim(
		policy: "ask" | "takeover",
		confirm: (record: Readonly<OwnerRecord>) => Promise<boolean> = async () => false,
	): Promise<OwnershipClaim> {
		if (this.record) return {};
		await mkdir(dirname(this.recordPath), { recursive: true });
		let transferredLink: LogicalLink | undefined;
		const existing = await readOwner(this.recordPath);
		if (existing) {
			if (!this.isProcessAlive(existing.pid)) {
				await removeIfMatching(this.recordPath, existing.nonce);
			} else {
				if (policy === "ask" && !(await confirm(existing))) {
					throw new Error(`QQ Gateway is owned by local Pi process ${existing.pid}`);
				}
				const response = await requestHandoff(existing, this.appId, this.userOpenId, this.handoffTimeoutMs);
				if (!response.ok) throw new Error(response.error ?? "live QQ Gateway owner refused handoff");
				transferredLink = response.link;
			}
		}

		const port = await this.startServer();
		const record: OwnerRecord = {
			appId: this.appId,
			userOpenId: this.userOpenId,
			pid: this.pid,
			nonce: this.nonce,
			port,
		};
		try {
			await writeFile(this.recordPath, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
			this.record = record;
			return { ...(transferredLink ? { transferredLink } : {}) };
		} catch (error) {
			await this.closeServer();
			throw error;
		}
	}

	async release(): Promise<void> {
		const nonce = this.record?.nonce;
		this.record = undefined;
		if (nonce) await removeIfMatching(this.recordPath, nonce);
		await this.closeServer();
	}

	private startServer(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer((socket) => { void this.handleSocket(socket); });
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				const address = server.address();
				if (!address || typeof address === "string") {
					server.close();
					reject(new Error("failed to allocate local QQ ownership endpoint"));
					return;
				}
				this.server = server;
				resolve(address.port);
			});
		});
	}

	private async handleSocket(socket: Socket): Promise<void> {
		try {
			const request = await readJsonLine<HandoffRequest>(socket, this.handoffTimeoutMs);
			if (
				request.action !== "release" ||
				request.nonce !== this.nonce ||
				request.appId !== this.appId ||
				request.userOpenId !== this.userOpenId
			) {
				socket.end(`${JSON.stringify({ ok: false, error: "ownership identity mismatch" })}\n`);
				return;
			}
			const link = await this.onRelease();
			await this.releaseRecordOnly();
			const response: HandoffResponse = { ok: true, ...(link ? { link } : {}) };
			socket.end(`${JSON.stringify(response)}\n`);
			setImmediate(() => { void this.closeServer(); });
		} catch (error) {
			const response: HandoffResponse = { ok: false, error: safeError(error) };
			socket.end(`${JSON.stringify(response)}\n`);
		}
	}

	private async releaseRecordOnly(): Promise<void> {
		const nonce = this.record?.nonce;
		this.record = undefined;
		if (nonce) await removeIfMatching(this.recordPath, nonce);
	}

	private closeServer(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return Promise.resolve();
		return new Promise((resolve) => server.close(() => resolve()));
	}
}

export function ownerRecordPath(appId: string): string {
	const key = createHash("sha256").update(appId).digest("hex").slice(0, 24);
	return join(homedir(), ".pi", "agent", "qqbot-owners", `${key}.json`);
}

async function requestHandoff(
	record: OwnerRecord,
	appId: string,
	userOpenId: string,
	timeoutMs: number,
): Promise<HandoffResponse> {
	const socket = connect({ host: "127.0.0.1", port: record.port });
	const response = readJsonLine<HandoffResponse>(socket, timeoutMs);
	socket.once("connect", () => {
		const request: HandoffRequest = { action: "release", appId, userOpenId, nonce: record.nonce };
		socket.write(`${JSON.stringify(request)}\n`);
	});
	try {
		return await response;
	} catch (error) {
		socket.destroy();
		throw new Error(`live QQ Gateway owner did not respond: ${safeError(error)}`);
	}
}

function readJsonLine<T>(socket: Socket, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => finish(new Error("local ownership request timed out")), timeoutMs);
		const finish = (error?: Error, value?: T) => {
			clearTimeout(timer);
			socket.removeAllListeners("data");
			socket.removeAllListeners("error");
			if (error) reject(error);
			else resolve(value as T);
		};
		socket.on("error", (error) => finish(error));
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline < 0) {
				if (buffer.length > 64 * 1024) finish(new Error("local ownership response is too large"));
				return;
			}
			try {
				finish(undefined, JSON.parse(buffer.slice(0, newline)) as T);
			} catch {
				finish(new Error("local ownership response is invalid"));
			}
		});
	});
}

async function readOwner(path: string): Promise<OwnerRecord | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value = JSON.parse(raw) as Partial<OwnerRecord>;
	if (
		typeof value.appId !== "string" ||
		typeof value.userOpenId !== "string" ||
		typeof value.pid !== "number" ||
		typeof value.nonce !== "string" ||
		typeof value.port !== "number"
	) throw new Error("QQ Gateway owner record is invalid");
	return value as OwnerRecord;
}

async function removeIfMatching(path: string, nonce: string): Promise<void> {
	const current = await readOwner(path);
	if (!current || current.nonce !== nonce) return;
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}
