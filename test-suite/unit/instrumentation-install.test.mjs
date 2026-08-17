// Regression: simply navigating with Pi Chrome Connector installed must not replace console.*.
// Capture is installed lazily by explicit snapshot/evaluate/console/network actions instead.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const src = fs.readFileSync(workerPath, "utf8");

const listeners = [];
const noop = () => {};
const listener = { addListener: noop, removeListener: noop };
const sandbox = {
  console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
  Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  fetch: async () => { throw new Error("no network"); },
  navigator: { userAgent: "unit-test" }, WebSocket: function () {},
  chrome: {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0" }), onInstalled: listener, onStartup: listener, lastError: null },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener },
    debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: listener, onEvent: listener },
    scripting: { executeScript: async (options) => { listeners.push(options); return []; } },
    tabs: { query: async () => [], get: async () => ({}), create: async () => ({}), update: async () => ({}), remove: async () => {} },
    windows: { update: async () => {} },
    webNavigation: { onCommitted: { addListener(fn) { listeners.push(fn); }, removeListener: noop } },
  },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

let failures = 0;
let passes = 0;
function ok(cond, msg) { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } }

ok(listeners.length === 0, "worker registers no global navigation-time capture injection");
ok(!/function installEarlyCapture\s*\(/.test(src), "early console/network monkey-patch implementation is removed");

const nativeLog = function nativeLog() {};
class XhrMock {
  open() {}
  send() {}
  addEventListener() {}
  getAllResponseHeaders() { return ""; }
}
const page = {
  console: { debug: nativeLog, log: nativeLog, info: nativeLog, warn: nativeLog, error: nativeLog },
  JSON, Date, Array, Object, String, Error,
  location: { href: "https://example.test/" },
  fetch: async () => ({ status: 200, statusText: "OK", ok: true, url: "https://example.test/api", headers: new Map(), clone: () => ({ text: async () => "ok" }) }),
  XMLHttpRequest: XhrMock,
  addEventListener() {},
};
page.window = page;
page.globalThis = page;
const pageWorld = vm.createContext(page);
const originalLog = page.console.log;
vm.runInContext(`${sandbox.getPiChromeState.toString()}\n(${sandbox.installPiChromeInstrumentation.toString()})()`, pageWorld);
ok(page.console.log !== originalLog, "explicit instrumentation still installs console capture on demand");
page.console.log("captured");
ok(page.__PI_CHROME_STATE__.console[0]?.args[0] === "captured", "explicit instrumentation still records console messages");

console.log(`\ninstrumentation-install: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
