import { access, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface SdkResolverOptions {
	explicit?: URL;
	resolveModule(specifier: string): Promise<string>;
	launcher?: string;
}

export async function resolveSdkUrl(options: SdkResolverOptions): Promise<URL> {
	const candidates: Array<{ source: string; value?: string }> = [
		{ source: "explicit", value: options.explicit?.protocol === "file:" ? options.explicit.pathname : options.explicit?.href },
	];
	try {
		candidates.push({ source: "module", value: await options.resolveModule("@earendil-works/pi-coding-agent") });
	} catch {
		// Launcher fallback remains available.
	}
	if (options.launcher) {
		const marker = join("@earendil-works", "pi-coding-agent");
		const normalized = options.launcher.replaceAll("\\", "/");
		const index = normalized.lastIndexOf(marker.replaceAll("\\", "/"));
		if (index >= 0) candidates.push({ source: "launcher", value: join(normalized.slice(0, index), marker, "dist", "index.js") });
		else candidates.push({ source: "launcher-adjacent", value: join(dirname(options.launcher), "index.js") });
	}
	for (const candidate of candidates) {
		if (!candidate.value) continue;
		try {
			const path = await realpath(candidate.value.startsWith("file:") ? new URL(candidate.value) : candidate.value);
			await access(path);
			if ((await stat(path)).isFile()) return pathToFileURL(path);
		} catch {
			// Try the next verified source without exposing its path.
		}
	}
	throw new Error(`Unable to resolve Pi SDK from ${candidates.map((candidate) => candidate.source).join(", ")}`);
}
