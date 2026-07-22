import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function collect(path: string): string[] {
	const absolute = resolve(path);
	if (statSync(absolute).isFile()) {
		return absolute.endsWith(".test.ts") ? [absolute] : [];
	}
	return readdirSync(absolute)
		.flatMap((entry) => collect(resolve(absolute, entry)))
		.sort();
}

const roots = process.argv.slice(2);
const includeDiscoveryFixture = process.env.RUN_DISCOVERY_FIXTURE === "1";
const files = (roots.length > 0 ? roots : ["test"])
	.flatMap(collect)
	.filter(
		(path) =>
			includeDiscoveryFixture ||
			(!path.includes("fixtures\\discovery") && !path.includes("fixtures/discovery")),
	);

for (const file of files) {
	const result = spawnSync(process.execPath, ["--import", "tsx", "--test", file], {
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}
