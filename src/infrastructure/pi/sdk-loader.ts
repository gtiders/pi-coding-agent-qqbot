import * as hostSdk from "@earendil-works/pi-coding-agent";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface SdkResolverOptions {
	explicit?: URL;
	resolveModule(specifier: string): Promise<string>;
	launcher?: string;
}

export async function resolveSdkUrl(options: SdkResolverOptions): Promise<URL> {
	const candidates: Array<{ source: string; value?: string | undefined }> = [
		{
			source: "explicit",
			value:
				options.explicit?.protocol === "file:"
					? options.explicit.pathname
					: options.explicit?.href,
		},
	];
	if (options.launcher) {
		const marker = join("@earendil-works", "pi-coding-agent");
		const normalized = options.launcher.replaceAll("\\", "/");
		const index = normalized.lastIndexOf(marker.replaceAll("\\", "/"));
		if (index >= 0) {
			candidates.push({
				source: "launcher",
				value: join(normalized.slice(0, index), marker, "dist", "index.js"),
			});
		} else {
			const launcherDir = dirname(options.launcher);
			candidates.push({
				source: "launcher-adjacent",
				value: join(launcherDir, "dist", "index.js"),
			});
			candidates.push({
				source: "launcher-adjacent-legacy",
				value: join(launcherDir, "index.js"),
			});
		}
	}
	try {
		candidates.push({
			source: "module",
			value: await options.resolveModule("@earendil-works/pi-coding-agent"),
		});
	} catch {
		// A verified launcher candidate may still be available.
	}
	for (const candidate of candidates) {
		if (!candidate.value) continue;
		try {
			const path = await realpath(
				candidate.value.startsWith("file:")
					? new URL(candidate.value)
					: candidate.value,
			);
			await access(path);
			if ((await stat(path)).isFile()) return pathToFileURL(path);
		} catch {
			// Try the next verified source without exposing its path.
		}
	}
	throw new Error(
		`Unable to resolve Pi SDK from ${candidates.map((candidate) => candidate.source).join(", ")}`,
	);
}

// Pi supplies this peer from its own module root. A static import is required:
// resolving from the extension directory can select a second, incompatible SDK.
// biome-ignore lint/suspicious/noExplicitAny: the host SDK has no stable aggregate runtime type.
export function loadPiSdk(): Promise<any> {
	for (const key of [
		"getAgentDir",
		"SettingsManager",
		"AgentSessionRuntime",
		"createAgentSessionServices",
	]) {
		if (!(key in hostSdk))
			throw new Error(`Pi SDK is missing required export: ${key}`);
	}
	return Promise.resolve(hostSdk);
}
