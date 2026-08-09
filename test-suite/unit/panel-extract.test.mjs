import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractPanelPages, normalizeOptions } = require("../../extensions/chrome-profile-bridge/panel-extract.js");

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else { failures++; console.error(`  ✗ ${msg}`); }
}
async function throwsWith(fn, re, msg) {
  try { await fn(); ok(false, `${msg} (expected throw)`); }
  catch (error) { ok(re.test(String(error.message || error)), `${msg} (got: ${error.message})`); }
}

function clock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (ms) => { value += ms; },
  };
}

async function run() {
  await throwsWith(() => Promise.resolve(normalizeOptions({ labels: ["A"] })), /panelId or panelUrl/, "requires a panel target");
  await throwsWith(() => Promise.resolve(normalizeOptions({ panelId: "p", labels: [] })), /1-50/, "requires labels");
  await throwsWith(() => Promise.resolve(normalizeOptions({ panelId: "p", labels: ["A", "A"] })), /unique/, "rejects duplicate labels");

  {
    const calls = [];
    const texts = ["baseline", "page A", "page A", "page B", "page B"];
    const send = async (action, params) => {
      calls.push({ action, params });
      if (action === "panel.clickText") return { ok: true };
      const text = texts.shift();
      return { ok: true, text, textLength: text.length, title: "Panel", url: "https://panel.test" };
    };
    const c = clock();
    const result = await extractPanelPages(
      { panelId: "p", labels: ["A", "B"], minWaitMs: 1000, pageTimeoutMs: 5000, pollIntervalMs: 1000 },
      send,
      { now: c.now, sleep: c.sleep },
    );
    ok(result.pages.length === 2 && result.pages.every((page) => page.status === "changed"), "extracts changed pages");
    ok(calls.filter((call) => call.action === "panel.clickText").length === 2, "clicks each label exactly once");
    ok(result.pages[0].attempts === 2 && result.pages[0].text === "page A", "requires two stable reads");
  }

  {
    let reads = 0;
    const c = clock();
    const result = await extractPanelPages(
      { panelUrl: "panel.test", labels: ["Same"], minWaitMs: 0, pageTimeoutMs: 3000, pollIntervalMs: 500 },
      async (action) => {
        if (action === "panel.clickText") return { ok: true };
        reads++;
        return { ok: true, text: "unchanged", textLength: 9 };
      },
      { now: c.now, sleep: c.sleep },
    );
    ok(result.pages[0].status === "unchanged", "marks unchanged content without claiming success");
    ok(result.pages[0].elapsedMs === 1000, "honors an explicit zero minimum wait while requiring stable reads");
    ok(reads >= 3, "captures baseline plus stable page reads");
  }

  {
    const texts = ["overview", "traffic", "traffic", "overview", "overview"];
    const c = clock();
    const result = await extractPanelPages(
      { panelId: "p", labels: ["Traffic", "Backlinks"], minWaitMs: 250, pageTimeoutMs: 1500, pollIntervalMs: 250 },
      async (action) => {
        if (action === "panel.clickText") return { ok: true };
        const text = texts.shift();
        return { ok: true, text, textLength: text.length };
      },
      { now: c.now, sleep: c.sleep },
    );
    ok(result.pages[0].status === "changed", "accepts a unique changed page");
    ok(result.pages[1].status === "duplicate" && result.pages[1].duplicateOf === "baseline", "flags a later page that returns to baseline content");
  }

  {
    let clicks = 0;
    const c = clock();
    const result = await extractPanelPages(
      { panelId: "p", labels: ["Missing", "Next"], minWaitMs: 250, pageTimeoutMs: 1000, pollIntervalMs: 250 },
      async (action, params) => {
        if (action === "panel.clickText") {
          clicks++;
          if (params.label === "Missing") return { ok: false, error: "not found", candidates: ["Next"] };
          return { ok: true };
        }
        return { ok: true, text: "text", textLength: 4 };
      },
      { now: c.now, sleep: c.sleep },
    );
    ok(result.pages[0].status === "not-found" && result.pages[1].label === "Next", "isolates missing labels and continues");
    ok(clicks === 2, "does not retry missing-label clicks");
  }

  {
    let clicks = 0;
    let reads = 0;
    const c = clock();
    const result = await extractPanelPages(
      { panelId: "p", labels: ["Credit page"], minWaitMs: 250, pageTimeoutMs: 1000, pollIntervalMs: 250 },
      async (action) => {
        if (action === "panel.clickText") { clicks++; throw new Error("timeout after delivery"); }
        reads++;
        if (reads === 1) return { ok: true, text: "baseline", textLength: 8 };
        return { ok: true, text: "credit data", textLength: 11 };
      },
      { now: c.now, sleep: c.sleep },
    );
    ok(clicks === 1, "never retries an uncertain click");
    ok(result.pages[0].status === "click-unknown" && result.pages[0].text === "credit data", "preserves data after uncertain click without claiming it switched");
  }

  {
    const c = clock();
    let label = "Broken";
    const result = await extractPanelPages(
      { panelId: "p", labels: ["Broken", "Good"], minWaitMs: 250, pageTimeoutMs: 750, pollIntervalMs: 250 },
      async (action, params) => {
        if (action === "panel.clickText") { label = params.label; return { ok: true }; }
        if (label === "Broken") throw new Error("read failed");
        return { ok: true, text: "good", textLength: 4 };
      },
      { now: c.now, sleep: c.sleep },
    );
    ok(result.pages[0].status === "read-error", "reports a page whose reads all fail");
    ok(result.pages[1].status === "changed" && result.pages[1].text === "good", "continues after a page read failure");
  }

  console.log(`\npanel-extract: ${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((error) => { console.error(error); process.exit(1); });
