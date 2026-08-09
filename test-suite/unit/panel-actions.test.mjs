import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const src = fs.readFileSync(workerPath, "utf8");
let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else { failures++; console.error(`  ✗ ${msg}`); }
}
function throwsWith(fn, re, msg) {
  try { fn(); ok(false, `${msg} (expected throw)`); }
  catch (error) { ok(re.test(String(error.message || error)), `${msg} (got: ${error.message})`); }
}

const noop = () => {};
const listener = { addListener: noop, removeListener: noop };
const sandbox = {
  console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
  Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  fetch: async () => { throw new Error("no network in unit test"); },
  navigator: { userAgent: "unit-test" }, WebSocket: function () {},
  chrome: {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener },
    debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]) },
    scripting: { executeScript: async () => [{ result: undefined }] },
    tabs: { query: async () => [], get: async () => ({}), create: async () => ({}), update: async () => ({}), remove: async () => {} },
    windows: { update: async () => {} }, webNavigation: { onCommitted: listener },
  },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const events = [];
function candidate(text, visible = true) {
  return {
    innerText: text,
    textContent: text,
    tagName: "BUTTON",
    getAttribute(name) { return name === "aria-selected" ? "false" : null; },
    getBoundingClientRect() { return { left: 10, top: 20, width: visible ? 100 : 0, height: 30 }; },
    dispatchEvent(event) { events.push(event.type); return true; },
  };
}
const hidden = candidate("Traffic", false);
const traffic = candidate("  Traffic\n", true);
const pageWorld = vm.createContext({
  console, JSON, Object, Array, String, Number, Boolean, Error,
  document: {
    title: "Panel",
    readyState: "complete",
    body: { innerText: "abcdef", textContent: "fallback" },
    querySelector(selector) { return selector === "body" ? this.body : null; },
    querySelectorAll() { return [hidden, traffic, candidate("Backlinks")]; },
  },
  location: { href: "https://panel.test/" },
  getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  PointerEvent: class { constructor(type) { this.type = type; } },
  MouseEvent: class { constructor(type) { this.type = type; } },
});
pageWorld.window = pageWorld;
pageWorld.globalThis = pageWorld;

const clicked = vm.runInContext(sandbox.panelClickTextExpression({ label: " Traffic ", navigationSelector: "button" }), pageWorld);
ok(clicked.ok === true && clicked.label === "Traffic", "click expression normalizes and exactly matches a visible label");
ok(events.join(",") === "pointerdown,mousedown,pointerup,mouseup,click", "click expression dispatches the full mouse event sequence");

const missing = vm.runInContext(sandbox.panelClickTextExpression({ label: "Missing" }), pageWorld);
ok(missing.ok === false && missing.candidates.includes("Backlinks"), "click expression returns candidates for a missing label");

const read = vm.runInContext(sandbox.panelReadTextExpression({ textSelector: "body", maxTextChars: 3 }), pageWorld);
ok(read.ok === true && read.text === "abc" && read.textLength === 6 && read.truncated === true, "read expression returns text metadata and truncates predictably");
const noRoot = vm.runInContext(sandbox.panelReadTextExpression({ textSelector: "#missing" }), pageWorld);
ok(noRoot.ok === false && /#missing/.test(noRoot.error), "read expression reports a missing text root");

throwsWith(() => sandbox.panelClickTextExpression({ label: "" }), /label of 1-200/, "click validation rejects an empty label");
throwsWith(() => sandbox.panelReadTextExpression({ textSelector: "x".repeat(501) }), /1-500/, "read validation rejects an oversized selector");

console.log(`\npanel-actions: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
