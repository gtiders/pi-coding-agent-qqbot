import assert from "node:assert/strict";

import { normalizeCommandText, parseQQCommand } from "./command-parser.ts";
import { formatUserFacingAgentError, humanizeSessionPreview } from "./user-facing.ts";

assert.equal(normalizeCommandText("／help"), "/help");
assert.equal(normalizeCommandText("\u200b/status"), "/status");
assert.equal(parseQQCommand("／model page 2")?.name, "model");
assert.equal(parseQQCommand("／model page 2")?.rawArgs, "page 2");

const technical = [
	"[QQ private user=FC9A82015BB9A80C3D51674E349BF8FD message=ROBOT1.0_abc!]",
	"",
	"列出当前工作目录下的文件名，最多5个",
	"",
	"<qq-reply-guidance>",
	"请为手机 QQ 聊天界面组织最终回答",
	"</qq-reply-guidance>",
].join("\n");
assert.equal(humanizeSessionPreview(technical), "列出当前工作目录下的文件名，最多5个");

assert.match(
	formatUserFacingAgentError(new Error("OpenAI API error (502): 502 Upstream authentication failed")),
	/模型服务/,
);
assert.match(formatUserFacingAgentError(new Error("aborted by user")), /中止/);

console.log("user-facing.test.ts: ok");
