// Regression tests for human-visible action summaries in index.ts.
// DOM fallback must never look like a trusted Chrome input success.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/index.ts");
const src = fs.readFileSync(indexPath, "utf8");
const match = src.match(/function summarizeActionResult\(result: unknown\): string \| undefined \{([\s\S]*?)\n\}/);
if (!match) throw new Error("summarizeActionResult not found");
const js = `function summarizeActionResult(result) {${match[1]}\n}`.replace(/ as Record<string, unknown>/g, "").replace(/ as \{ tag\?: string; id\?: string \}/g, "").replace(/: string\[\]/g, "");
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(js, sandbox);

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const fallback = sandbox.summarizeActionResult({ input: "dom-fallback", reason: "CDP Input.dispatchMouseEvent timed out" });
ok(/synthetic/i.test(fallback || "") && /isTrusted=false/.test(fallback || ""), "DOM fallback summary explicitly says synthetic and isTrusted=false");

const chrome = sandbox.summarizeActionResult({ input: "chrome" });
ok(chrome === undefined, "trusted Chrome input adds no warning");

console.log(`\ntool-summary: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
