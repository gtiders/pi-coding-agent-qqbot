import type { TerminalState } from "./event-reducer.ts";

export function renderConversationLines(state: TerminalState, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	return state.lines.map((line) => line.text.length <= safeWidth ? line.text : `${line.text.slice(0, Math.max(0, safeWidth - 1))}…`);
}
