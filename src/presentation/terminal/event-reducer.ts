import type { QQTerminalEvent } from "../../application/ports.ts";

export interface TerminalLine {
	kind: string;
	text: string;
	at: number;
}

export interface TerminalState {
	connection: string;
	queueSize: number;
	running: boolean;
	lines: TerminalLine[];
	disposed: boolean;
}

export function initialTerminalState(): TerminalState {
	return { connection: "disconnected", queueSize: 0, running: false, lines: [], disposed: false };
}

export function reduceTerminalEvent(state: TerminalState, event: QQTerminalEvent, historyLimit = 200): TerminalState {
	if (state.disposed) return state;
	if (event.kind === "runtime_state") {
		return { ...state, connection: event.connection, queueSize: event.queueSize, running: event.running };
	}
	const text = event.kind === "inbound" ? event.text : event.kind.replaceAll("_", " ");
	const limit = Math.max(0, Math.floor(historyLimit));
	const lines = limit === 0 ? [] : [...state.lines, { kind: event.kind, text, at: event.at }].slice(-limit);
	return { ...state, lines };
}

export function disposeTerminalState(state: TerminalState): TerminalState {
	return { ...state, disposed: true };
}
