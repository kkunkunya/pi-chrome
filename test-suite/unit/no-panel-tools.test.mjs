// Side-panel/AITDK integration is intentionally outside pi-chrome's supported tool surface.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const index = fs.readFileSync(path.resolve(__dirname, "../../extensions/chrome-profile-bridge/index.ts"), "utf8");
const worker = fs.readFileSync(path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js"), "utf8");

let failures = 0;
let passes = 0;
function ok(cond, msg) { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } }

ok(!/chrome_panels|chrome_panel_extract|panelId|panelUrl|AITDK/.test(index), "Pi tool schemas and primer expose no panel capability");
ok(!/case "panel\.|findPanelTarget|attachPanel|panelId|panelUrl|AITDK/.test(worker), "companion service worker exposes no panel action or target path");

console.log(`\nno-panel-tools: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
