import { ReplyBudget } from "../domain/reply-budget.ts";
import type { QQReplyPort, QQReplyTarget } from "./ports.ts";

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

export class ReplyBudgetExhaustedError extends Error {
	constructor(readonly required: number, readonly available: number) {
		super(`Reply requires ${required} sequence(s), but only ${available} remain`);
		this.name = "ReplyBudgetExhaustedError";
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
		assertCapacity(budget, maxChunks);
		for (let index = 0; index < maxChunks; index++) {
			if (!useMarkdown) {
				const plain = requiredChunk(options.formatted.plain, index, "plain");
				const sequence = reserveRequired(budget, "plain");
				await replies.sendText(options.target, plain, sequence);
			} else {
				const markdown = requiredChunk(options.formatted.markdown, index, "markdown");
				const markdownSequence = reserveRequired(budget, "markdown");
				try {
					await replies.sendMarkdown(
						options.target,
						markdown,
						markdownSequence,
						index === maxChunks - 1 ? options.keyboard : undefined,
					);
				} catch (error) {
					if (!options.canFallback(error)) throw error;
					options.onFallback?.(error);
					const remainingPlainChunks = maxChunks - index;
					assertCapacity(budget, remainingPlainChunks);
					const plain = requiredChunk(options.formatted.plain, index, "plain fallback");
					const plainSequence = reserveRequired(budget, "plain");
					await replies.sendText(options.target, plain, plainSequence);
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

function assertCapacity(budget: ReplyBudget, required: number): void {
	if (budget.remaining < required) throw new ReplyBudgetExhaustedError(required, budget.remaining);
}

function reserveRequired(budget: ReplyBudget, purpose: "markdown" | "plain"): number {
	const sequence = budget.reserve(purpose);
	if (sequence === undefined) throw new ReplyBudgetExhaustedError(1, 0);
	return sequence;
}

function requiredChunk(chunks: readonly string[], index: number, kind: string): string {
	const chunk = chunks[index];
	if (chunk === undefined) throw new Error(`Missing ${kind} reply chunk ${index + 1}`);
	return chunk;
}
