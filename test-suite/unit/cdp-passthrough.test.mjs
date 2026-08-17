// Unit tests for chrome_cdp (cdpPassthrough) and chrome_pdf (renderPdf/pdfParams)
// in service_worker.js. Loads the worker into a vm sandbox with mocked chrome.*,
// then exercises the raw-CDP passthrough and Page.printToPDF paths with a shimmed
// cdpRaw. No browser, no network, no deps.

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
  if (cond) { passes++; }
  else { failures++; console.error(`  ✗ ${msg}`); }
}
async function throwsWith(fn, re, msg) {
  try { await fn(); ok(false, `${msg} (expected throw)`); }
  catch (e) { ok(re.test(String(e.message || e)), `${msg} (got: ${e.message})`); }
}

const noop = () => {};
const listener = { addListener: noop, removeListener: noop };
const sandbox = {
  console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
  Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
  setTimeout, clearTimeout,
  setInterval: () => 0,
  clearInterval: noop,
  fetch: async () => { throw new Error("no network in unit test"); },
  navigator: { userAgent: "unit-test" },
  WebSocket: function () {},
  chrome: {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener },
    debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]) },
    scripting: { executeScript: async () => [{ result: undefined }] },
    tabs: { query: async () => [], get: async () => ({}), create: async () => ({}), update: async () => ({}), remove: async () => {} },
    windows: { update: async () => {} },
    webNavigation: { onCommitted: listener },
  },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(src + "\nglobalThis.__attachedTabs = attachedTabs;", sandbox);
const realCdp = sandbox.cdp;

// ---- shim the primitives the new handlers rely on ----
const calls = [];
sandbox.getTabByParams = async (p) => ({ id: Number((p && p.targetId) || 1), windowId: 1 });
sandbox.bringToFront = async () => {};
sandbox.formatTab = async (tab) => ({ ...tab, url: "https://example.com", title: "t" });
sandbox.cdpRaw = async (tabId, method, params) => {
  calls.push({ tabId, method, params });
  if (method === "Page.printToPDF") return { data: "SGVscw==" }; // base64 "Hels"
  return { ok: true, echoed: params };
};
sandbox.cdp = (...args) => sandbox.cdpRaw(...args);
const attached = [];
sandbox.attachDebugger = async (tabId) => { attached.push(tabId); return {}; };

(async () => {
  // pdfParams: defaults + clamps
  const pp = (p) => sandbox.pdfParams(p || {});
  ok(pp().paperFormat === "letter", "pdfParams default paperFormat letter");
  ok(pp().scale === 1 && pp().printBackground === true && pp().landscape === false, "pdfParams defaults scale/background/landscape");
  ok(pp({ scale: 9 }).scale === 2 && pp({ scale: 0.01 }).scale === 0.1, "pdfParams clamps scale to [0.1, 2]");
  ok(pp({ landscape: true, printBackground: false, paperFormat: "a4" }).landscape === true, "pdfParams landscape true");
  ok(pp({ landscape: true, printBackground: false, paperFormat: "a4" }).printBackground === false, "pdfParams printBackground false honored");

  // cdpPassthrough: method validation
  await throwsWith(() => sandbox.cdpPassthrough({ method: "" }), /requires a CDP method/, "cdpPassthrough rejects empty method");
  await throwsWith(() => sandbox.cdpPassthrough({ method: "not-a-method" }), /requires a CDP method/, "cdpPassthrough rejects malformed method");
  await throwsWith(() => sandbox.cdpPassthrough({}), /requires a CDP method/, "cdpPassthrough rejects missing method");

  // cdpPassthrough: forwards method + params on the resolved tab
  const out = await sandbox.cdpPassthrough({ method: "Page.getLayoutMetrics", params: { foo: 1 }, targetId: "7" });
  ok(out && out.ok === true && out.echoed && out.echoed.foo === 1, "cdpPassthrough returns raw CDP response");
  ok(calls.length === 1 && calls[0].method === "Page.getLayoutMetrics" && calls[0].params.foo === 1 && calls[0].tabId === 7, "cdpPassthrough forwards method/params/tabId");
  ok(attached.length === 1 && attached[0] === 7, "cdpPassthrough attaches a cold tab before the first CDP command");

  // renderPdf: returns base64 data + formatted tab
  const pdf = await sandbox.renderPdf({ targetId: "7", landscape: true });
  ok(pdf && pdf.dataBase64 === "SGVscw==", "renderPdf returns base64 PDF data");
  ok(pdf.tab && pdf.tab.url === "https://example.com", "renderPdf returns formatted tab");
  ok(calls.length === 2 && calls[1].method === "Page.printToPDF" && calls[1].params.landscape === true, "renderPdf calls Page.printToPDF with landscape");
  ok(attached.length === 2 && attached[1] === 7, "renderPdf attaches a cold tab before printToPDF");

  // CDP timeout recovery: clear the cached session, reattach, and retry exactly once.
  sandbox.__attachedTabs.set(7, { debuggee: { tabId: 7 }, detachAt: Date.now() + 1000 });
  let attempts = 0;
  attached.length = 0;
  sandbox.cdpRaw = async () => {
    attempts++;
    if (attempts === 1) throw new Error("CDP Input.dispatchMouseEvent timed out after 5000ms");
    return { recovered: true };
  };
  const recovered = await realCdp(7, "Input.dispatchMouseEvent", {});
  ok(recovered?.recovered === true && attempts === 2, "cdp retries one timed-out input command");
  ok(attached.length === 1 && attached[0] === 7, "cdp timeout recovery reattaches the tab");

  // renderPdf: error when no data
  sandbox.cdpRaw = async () => ({});
  sandbox.cdp = (...args) => sandbox.cdpRaw(...args);
  await throwsWith(() => sandbox.renderPdf({}), /no data/, "renderPdf throws when CDP returns no data");

  console.log(`\ncdp-passthrough: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
