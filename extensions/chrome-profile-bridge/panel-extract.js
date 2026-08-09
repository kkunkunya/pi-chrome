"use strict";

const DEFAULT_NAVIGATION_SELECTOR = 'button,[role="tab"],[role="button"],a';
const DEFAULT_TEXT_SELECTOR = "body";

function abortError() {
  const error = new Error("Chrome panel extraction aborted");
  error.name = "AbortError";
  return error;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeOptions(params) {
  const labels = (params.labels || []).map((label) => String(label).replace(/\s+/g, " ").trim());
  if (!params.panelId && !params.panelUrl) throw new Error("chrome_panel_extract requires panelId or panelUrl");
  if (!labels.length || labels.length > 50 || labels.some((label) => !label || label.length > 200)) {
    throw new Error("chrome_panel_extract requires 1-50 non-empty labels of at most 200 characters");
  }
  if (new Set(labels).size !== labels.length) throw new Error("chrome_panel_extract labels must be unique");
  const navigationSelector = String(params.navigationSelector || DEFAULT_NAVIGATION_SELECTOR).trim();
  const textSelector = String(params.textSelector || DEFAULT_TEXT_SELECTOR).trim();
  if (!navigationSelector || navigationSelector.length > 500 || !textSelector || textSelector.length > 500) {
    throw new Error("chrome_panel_extract selectors must be 1-500 characters");
  }
  return {
    labels,
    navigationSelector,
    textSelector,
    maxTextChars: Math.max(1, Math.min(2_000_000, Number(params.maxTextChars) || 500_000)),
    minWaitMs: Math.max(0, Math.min(20_000, params.minWaitMs === undefined ? 4_000 : Number(params.minWaitMs))),
    pageTimeoutMs: Math.max(1_000, Math.min(60_000, params.pageTimeoutMs === undefined ? 20_000 : Number(params.pageTimeoutMs))),
    pollIntervalMs: Math.max(250, Math.min(5_000, params.pollIntervalMs === undefined ? 1_000 : Number(params.pollIntervalMs))),
  };
}

async function extractPanelPages(params, send, options = {}) {
  const config = normalizeOptions(params);
  const signal = options.signal;
  const sleep = options.sleep || delay;
  const now = options.now || Date.now;
  const onProgress = options.onProgress;
  const onPage = options.onPage;
  const target = params.panelId ? { panelId: params.panelId } : { panelUrl: params.panelUrl };
  const readParams = { ...target, textSelector: config.textSelector, maxTextChars: config.maxTextChars };
  let previousText;
  try {
    const baseline = await send("panel.readText", readParams);
    if (baseline?.ok) previousText = baseline.text;
  } catch {}

  const startedAt = new Date(now()).toISOString();
  const pages = [];
  const artifact = (completedAt = null) => ({
    panel: target,
    startedAt,
    completedAt,
    options: {
      navigationSelector: config.navigationSelector,
      textSelector: config.textSelector,
      maxTextChars: config.maxTextChars,
      minWaitMs: config.minWaitMs,
      pageTimeoutMs: config.pageTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
    },
    pages,
  });
  const addPage = async (page) => {
    pages.push(page);
    await onPage?.(artifact());
  };
  const seenTexts = new Map(previousText === undefined ? [] : [[previousText, "baseline"]]);
  for (let index = 0; index < config.labels.length; index++) {
    if (signal?.aborted) throw abortError();
    const label = config.labels[index];
    onProgress?.({ index, total: config.labels.length, label });
    const pageStarted = now();
    const errors = [];
    const recordError = (message) => {
      if (errors.length < 10 && !errors.includes(message)) errors.push(message);
    };
    let clicked = false;
    let clickUnknown = false;
    try {
      const click = await send("panel.clickText", { ...target, label, navigationSelector: config.navigationSelector });
      if (!click?.ok) {
        await addPage({ label, status: "not-found", clicked: false, elapsedMs: now() - pageStarted, error: click?.error || "navigation element not found", candidates: click?.candidates || [] });
        continue;
      }
      clicked = true;
    } catch (error) {
      clickUnknown = true;
      recordError(`click: ${error?.message || String(error)}`);
    }

    const deadline = pageStarted + config.pageTimeoutMs;
    let latest;
    let lastText;
    let stableReads = 0;
    let attempts = 0;
    while (now() < deadline) {
      await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadline - now())), signal);
      attempts++;
      try {
        const read = await send("panel.readText", readParams);
        if (!read?.ok) {
          recordError(`read: ${read?.error || "unknown panel read error"}`);
          continue;
        }
        latest = read;
        stableReads = read.text === lastText ? stableReads + 1 : 1;
        lastText = read.text;
        if (now() - pageStarted >= config.minWaitMs && stableReads >= 2) break;
      } catch (error) {
        recordError(`read: ${error?.message || String(error)}`);
      }
    }

    if (!latest) {
      await addPage({ label, status: clickUnknown ? "click-unknown" : "read-error", clicked, elapsedMs: now() - pageStarted, attempts, errors });
      continue;
    }
    const duplicateOf = latest.text === previousText ? undefined : seenTexts.get(latest.text);
    const status = clickUnknown ? "click-unknown" : latest.text === previousText ? "unchanged" : duplicateOf ? "duplicate" : "changed";
    await addPage({
      label,
      status,
      ...(duplicateOf ? { duplicateOf } : {}),
      clicked,
      elapsedMs: now() - pageStarted,
      attempts,
      text: latest.text,
      textLength: latest.textLength,
      truncated: latest.truncated === true,
      title: latest.title,
      url: latest.url,
      ...(errors.length ? { errors } : {}),
    });
    if (!seenTexts.has(latest.text) || seenTexts.get(latest.text) === "baseline") seenTexts.set(latest.text, label);
    previousText = latest.text;
  }

  return artifact(new Date(now()).toISOString());
}

module.exports = { extractPanelPages, normalizeOptions };
