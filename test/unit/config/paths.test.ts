import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";

import { configPath } from "../../../src/infrastructure/config/paths.ts";

test("builds the new native config path", () => {
	assert.equal(configPath("C:\\Users\\me", win32), "C:\\Users\\me\\.pi\\agent\\pi-agent-qqbot.json");
	assert.equal(configPath("/Users/me", posix), "/Users/me/.pi/agent/pi-agent-qqbot.json");
});
