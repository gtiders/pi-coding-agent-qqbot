import { ReplyBudget } from "../domain/reply-budget.ts";
import type { QQReplyPort, QQReplyTarget } from "./ports.ts";

export interface DeliverReplyOptions {
	target: QQReplyTarget;
	text: string;
	progress?: string;
}

export async function deliverReply(replies: QQReplyPort, budget: ReplyBudget, options: DeliverReplyOptions): Promise<void> {
	if (options.progress) {
		const seq = budget.reserve("progress", { once: true, keepFinal: true });
		if (seq !== undefined) await replies.sendText(options.target, options.progress, seq);
	}
	const seq = budget.reserve("final");
	if (seq !== undefined) await replies.sendText(options.target, options.text, seq);
}
