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

export interface RichReplyPort<TKeyboard> extends QQReplyPort {
	sendMarkdown(target: QQReplyTarget, markdown: string, seq: number, keyboard?: TKeyboard): Promise<void>;
}

export interface FormattedReply {
	plain: string[];
	markdown: string[];
}

export interface FormattedDeliveryOptions<TKeyboard> {
	target: QQReplyTarget;
	formatted: FormattedReply;
	useMarkdown: boolean;
	forceSingleChunk?: boolean;
	keyboard?: TKeyboard;
	canFallback(error: unknown): boolean;
	onFallback?(error: unknown): void;
}

export interface FormattedDeliveryResult {
	delivery: "markdown" | "plain" | "plain-fallback";
	sentChunks: number;
}

export class ReplyDeliveryError extends Error {
	constructor(readonly sentChunks: number, readonly cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "ReplyDeliveryError";
	}
}

/** Own sequence allocation for formatted reply chunks and Markdown fallback. */
export async function deliverFormattedReply<TKeyboard>(
	replies: RichReplyPort<TKeyboard>,
	budget: ReplyBudget,
	options: FormattedDeliveryOptions<TKeyboard>,
): Promise<FormattedDeliveryResult> {
	const chunks = options.useMarkdown ? options.formatted.markdown : options.formatted.plain;
	const maxChunks = options.forceSingleChunk ? Math.min(1, chunks.length) : chunks.length;
	let useMarkdown = options.useMarkdown;
	let delivery: FormattedDeliveryResult["delivery"] = useMarkdown ? "markdown" : "plain";
	let sentChunks = 0;
	try {
		for (let index = 0; index < maxChunks; index++) {
			if (!useMarkdown) {
				const sequence = budget.reserve("plain");
				if (sequence === undefined) break;
				await replies.sendText(options.target, options.formatted.plain[index], sequence);
			} else {
				const markdownSequence = budget.reserve("markdown");
				if (markdownSequence === undefined) break;
				try {
					await replies.sendMarkdown(
						options.target,
						options.formatted.markdown[index],
						markdownSequence,
						index === maxChunks - 1 ? options.keyboard : undefined,
					);
				} catch (error) {
					if (!options.canFallback(error)) throw error;
					options.onFallback?.(error);
					const plainSequence = budget.reserve("plain");
					if (plainSequence === undefined) break;
					await replies.sendText(options.target, options.formatted.plain[index], plainSequence);
					useMarkdown = false;
					delivery = "plain-fallback";
				}
			}
			sentChunks++;
		}
		return { delivery, sentChunks };
	} catch (error) {
		throw new ReplyDeliveryError(sentChunks, error);
	}
}
