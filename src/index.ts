import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerExtension from "./extension/extension.ts";

export default function piAgentQQBot(pi: ExtensionAPI): void {
	registerExtension(pi);
}
