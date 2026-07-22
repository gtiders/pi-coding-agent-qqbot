import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const root = process.cwd();
const roots = [resolve(root, "src")];
const files = [resolve(root, "package.json"), resolve(root, "README.md"), resolve(root, "pi-agent-qqbot.json.example")];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if ([".ts", ".json", ".md"].includes(extname(path))) files.push(path);
  }
}
for (const directory of roots) await collect(directory);
const forbidden = [
  /@xsqm\/pi-qqbot/g,
  /pi-coding-agent-qqbot/g,
  /pi-qqbot\.json/g,
  /\/mnt\/c/gi,
  /(?:^|[^-])pi-qqbot(?:[^-]|$)/g,
];
const failures = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const pattern of forbidden) if (pattern.test(text)) failures.push(`${relative(root, file)}: ${pattern}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`identity check passed (${files.length} files)`);
