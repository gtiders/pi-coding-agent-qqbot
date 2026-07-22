import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const workspace = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-package-"));
try {
  const npmrc = join(workspace, "isolated-npmrc");
  await writeFile(npmrc, "audit=false\nfund=false\n");
  const npmEnv = { ...process.env };
  for (const key of Object.keys(npmEnv)) {
    if (["npm_config_allow_scripts", "npm_config_userconfig"].includes(key.toLowerCase())) delete npmEnv[key];
  }
  npmEnv.NPM_CONFIG_USERCONFIG = npmrc;
  const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", workspace], { cwd: root, encoding: "utf8", env: npmEnv, shell: process.platform === "win32" });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const [result] = JSON.parse(packed.stdout);
  const paths = result.files.map((file) => file.path);
  for (const required of ["src/index.ts", "README.md", "LICENSE", "pi-agent-qqbot.json.example"]) assert.ok(paths.includes(required), `missing ${required}`);
  for (const path of paths) {
    for (const forbidden of [/\.test\.ts$/, /^test\//, /^docs\//, /pi-agent-qqbot\.json$/, /\.env/, /\.git/, /\.pi-subagents/]) assert.doesNotMatch(path, forbidden);
  }
  const consumer = join(workspace, "consumer");
  await import("node:fs/promises").then((fs) => fs.mkdir(consumer));
  await writeFile(join(consumer, "package.json"), "{\"private\":true}\n");
  const installed = spawnSync("npm", ["install", resolve(workspace, result.filename), "--ignore-scripts", "--legacy-peer-deps"], { cwd: consumer, encoding: "utf8", env: npmEnv, shell: process.platform === "win32" });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const tree = spawnSync("npm", ["ls", "--omit=dev", "--legacy-peer-deps"], { cwd: consumer, encoding: "utf8", env: npmEnv, shell: process.platform === "win32" });
  assert.equal(tree.status, 0, tree.stderr || tree.stdout);
  const metadata = JSON.parse(await readFile(join(consumer, "node_modules", "pi-agent-qqbot", "package.json"), "utf8"));
  assert.deepEqual(Object.keys(metadata.peerDependencies).sort(), ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]);
  console.log(`package check passed (${paths.length} files)`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
