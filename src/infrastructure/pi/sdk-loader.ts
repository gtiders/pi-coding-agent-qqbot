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

// The Pi SDK does not publish one stable aggregate runtime type. Keep the
// dynamic boundary here and validate the entry points used by this package.
// biome-ignore lint/suspicious/noExplicitAny: verified dynamic SDK namespace.
let sdkPromise: Promise<any> | undefined;

// biome-ignore lint/suspicious/noExplicitAny: verified dynamic SDK namespace.
export function loadPiSdk(): Promise<any> {
	if (!sdkPromise) {
		const launcher = process.argv[1];
		const options: SdkResolverOptions = {
			resolveModule: async (specifier) => import.meta.resolve(specifier),
			...(launcher ? { launcher } : {}),
		};
		sdkPromise = resolveSdkUrl(options).then(async (url) => {
			const sdk = await import(url.href);
			for (const key of ["getAgentDir", "SettingsManager", "AgentSessionRuntime", "createAgentSessionServices"]) {
				if (!(key in sdk)) throw new Error(`Pi SDK is missing required export: ${key}`);
			}
			return sdk;
		});
	}
	return sdkPromise;
}
