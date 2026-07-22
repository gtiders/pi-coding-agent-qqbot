import type { AgentSessionPort, AgentTurnInput, AgentTurnResult } from "./ports.ts";

export interface PreparedAgentInput {
	input: AgentTurnInput;
	cleanup(): Promise<void>;
}

export interface TurnAttachmentPort {
	prepare(): Promise<PreparedAgentInput>;
}

export async function runAgentTurn(session: AgentSessionPort, attachments: TurnAttachmentPort, closeOutbound: () => Promise<void>, onCleanupError: (error: unknown, primary?: unknown) => void): Promise<AgentTurnResult> {
	let prepared: PreparedAgentInput | undefined;
	let primary: unknown;
	try {
		prepared = await attachments.prepare();
		return await session.run(prepared.input);
	} catch (error) {
		primary = error;
		throw error;
	} finally {
		await closeOutbound().catch((error: unknown) => onCleanupError(error, primary));
		await prepared?.cleanup().catch((error: unknown) => onCleanupError(error, primary));
	}
}
