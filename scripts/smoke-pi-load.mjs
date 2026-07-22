import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const target = resolve(process.argv[2] ?? ".");
const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-qqbot-smoke-"));
const command = process.platform === "win32" ? "pi.cmd" : "pi";
const child = spawn(command, ["--mode", "rpc", "--no-session", "--no-extensions", "-e", join(target, "src", "index.ts")], {
  cwd: target,
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});
let output = "";
let errors = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { errors += chunk; });
child.stdin.write(`${JSON.stringify({ type: "get_commands", id: "commands" })}\n`);
const timeout = setTimeout(() => child.kill(), 20_000);
try {
  await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", resolveExit);
    setTimeout(() => { child.stdin.write(`${JSON.stringify({ type: "shutdown", id: "shutdown" })}\n`); child.stdin.end(); }, 1000);
  });
  assert.match(output, /qqbot-start/);
  assert.match(output, /qqbot-status/);
  assert.equal(errors.includes("gateway socket"), false, errors);
  console.log("Pi RPC smoke passed");
} finally {
  clearTimeout(timeout);
  child.kill();
  await rm(agentDir, { recursive: true, force: true });
}
