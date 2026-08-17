import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(__dirname, "../challenges/21-keyboard-modifiers.html"), "utf8");
const ok = /addEventListener\("keyup", \(event\) => \{\s*if \(event\.key !== "Shift"/.test(html);
if (!ok) { console.error("keyboard modifier challenge grades before Shift keyup"); process.exit(1); }
console.log("keyboard-modifier-challenge: 1 passed, 0 failed");
