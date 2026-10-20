import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const root = resolve(import.meta.dirname, "..");
const path = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8" }).trim();
const target = resolve(root, path);
const current = existsSync(target) ? readFileSync(target, "utf8") : "";
const patterns = ["/docs/", "/artifacts/", "/.local/"];
const missing = patterns.filter(item => !current.split("\n").includes(item));
mkdirSync(dirname(target), { recursive: true });
if (missing.length) writeFileSync(target, current + "\n# Local design and operating materials\n" + missing.join("\n") + "\n");
console.log("Local Git exclusions configured: docs/, artifacts/, .local/");
