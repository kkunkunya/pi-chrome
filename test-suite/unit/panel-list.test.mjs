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

const noop = () => {};
const listener = { addListener: noop, removeListener: noop };
const targets = [
  { id: "tab-1", tabId: 101, type: "page", url: "https://one.test/" },
  { id: "tab-2", tabId: 102, type: "page", url: "https://two.test/" },
  { id: "tab-3", tabId: 103, type: "page", url: "https://other.test/" },
  { id: "panel-1", type: "other", url: "https://extension.aitdk.com/" },
  { id: "panel-2", type: "other", url: "https://extension.aitdk.com/" },
  { id: "panel-3", type: "other", url: "https://extension.aitdk.com/" },
  { id: "noise", type: "iframe", url: "https://noise.test/embed" },
];
const tabs = [
  { id: 101, windowId: 1, active: true, highlighted: true, title: "One", url: "https://one.test/", status: "complete", groupId: 7 },
  { id: 102, windowId: 1, active: false, highlighted: false, title: "Two", url: "https://two.test/", status: "complete", groupId: 7 },
  { id: 103, windowId: 2, active: true, highlighted: true, title: "Other", url: "https://other.test/", status: "complete", groupId: 8 },
];
const groups = [
  { id: 7, title: "Pi Session: wanted", color: "blue", windowId: 1, collapsed: false },
  { id: 8, title: "Pi Session: other", color: "blue", windowId: 2, collapsed: false },
];
const noopChrome = {
  runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null },
  alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
  action: { onClicked: listener },
  debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb(targets) },
  scripting: { executeScript: async () => [{ result: undefined }] },
  tabs: {
    query: async (query) => query?.active ? [tabs[0]] : tabs,
    get: async (id) => tabs.find((tab) => tab.id === id),
    create: async () => ({}), update: async () => ({}), remove: async () => {},
  },
  tabGroups: {
    query: async () => groups,
    get: async (id) => groups.find((group) => group.id === id),
  },
  windows: { update: async () => {} },
  webNavigation: { onCommitted: listener },
};
const sandbox = {
  console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
  Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  fetch: async () => { throw new Error("no network in unit test"); },
  navigator: { userAgent: "unit-test" }, WebSocket: function () {}, chrome: noopChrome,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const probes = {
  "panel-1": { title: "AITDK", topLevel: false, textLen: 1000, parentId: "tab-1" },
  "panel-2": { title: "AITDK", topLevel: false, textLen: 200, parentId: "tab-2" },
  "panel-3": { title: "AITDK", topLevel: false, textLen: 3000, parentId: "tab-3" },
  noise: { title: "Noise", topLevel: false, textLen: 10, parentId: "tab-1" },
};
sandbox.probePanelTarget = async (target) => probes[target.id] || { attachError: "blocked" };

const all = await sandbox.dispatch("panel.list", { includeAllInstances: true, urlIncludes: "extension.aitdk.com" });
ok(all.length === 3, "explicit all-instance discovery preserves same-URL panels even during a low-text loading state");
ok(all[0].hostTab.id === 101 && all[1].hostTab.id === 102 && all[2].hostTab.id === 103, "maps each panel parent target to its host tab");
ok(all[0].current === true && all[1].current === false, "marks the active host instance current");

const defaultList = await sandbox.dispatch("panel.list", { urlIncludes: "extension.aitdk.com" });
ok(defaultList.length === 1 && defaultList[0].id === "panel-1", "default list keeps one current representative and retains the broad iframe heuristic");

const session = await sandbox.dispatch("panel.list", {
  includeAllInstances: true,
  sessionOnly: true,
  groupTitle: "Pi Session: wanted",
  urlIncludes: "extension.aitdk.com",
});
ok(session.length === 2, "sessionOnly keeps every panel hosted in the requested Pi group");
ok(session.every((panel) => panel.hostTab.group.title === "Pi Session: wanted"), "sessionOnly exposes the matching host group metadata");
ok(!session.some((panel) => panel.id === "panel-3"), "sessionOnly excludes other Pi sessions");

const noMatch = await sandbox.dispatch("panel.list", { includeAllInstances: true, urlIncludes: "missing.test" });
ok(noMatch.length === 0, "urlIncludes filters panel URLs before probing");

console.log(`\npanel-list: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
