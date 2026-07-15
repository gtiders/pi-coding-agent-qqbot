/**
 * User-facing copy helpers for QQ replies and session previews.
 * Kept free of Pi SDK imports so unit tests can run under strip-types.
 */

const SUMMARY_MAX = 120;

/**
 * Turn stored session prompt text into a human-readable QQ preview.
 * Strips technical QQ headers, reply-guidance blocks, and attachment XML.
 */
export function humanizeSessionPreview(text: string): string {
	if (!text) return "";
	let value = text.replace(/\r\n?/g, "\n");
	value = value.replace(/<qq-reply-guidance>[\s\S]*?<\/qq-reply-guidance>/gi, "");
	value = value.replace(/<qq-attachments[\s\S]*?<\/qq-attachments>/gi, "");
	value = value.replace(/<qq-voice[\s\S]*?<\/qq-voice>/gi, "");
	value = value.replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/gi, "");
	const lines = value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !/^\[QQ\s+(?:private|group)\b/i.test(line))
		.filter((line) => !line.startsWith("<"));
	const joined = lines.join(" ").replace(/\s+/g, " ").trim();
	return truncatePreview(joined);
}

/** Map raw agent/runtime errors to short, user-facing Chinese copy. */
export function formatUserFacingAgentError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const msg = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	if (!msg) return "处理失败，请稍后重试。";
	if (/aborted|abort|cancel/i.test(msg)) return "任务已中止。";
	if (/401|403|authentication|unauthorized|api key|invalid.*key/i.test(msg)) {
		return "模型服务认证失败，请检查主机上的模型/API 配置后重试。";
	}
	if (/502|503|504|timeout|ETIMEDOUT|ECONNRESET|upstream|temporar/i.test(msg)) {
		return "模型服务暂时不可用或超时，请稍后重试。也可先发送 /status 查看连接状态。";
	}
	if (/network|ENOTFOUND|fetch failed|socket/i.test(msg)) {
		return "网络异常，暂时无法完成处理。请稍后重试。";
	}
	const short = msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
	return `处理失败：${short}\n\n你可以换个说法重试，或发送 /stop 后重新开始。`;
}

function truncatePreview(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX)}…` : oneLine;
}
