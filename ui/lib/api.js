// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
// Talks to the local backend. In the app, the Tauri side starts the backend
// and hands over its address and token; in a browser (development) they come
// from the page URL: index.html?api=http://127.0.0.1:8765&token=...

let base = null;
let token = null;
let startError = null;

export async function init() {
  const tauri = window.__TAURI__;
  if (tauri && tauri.core) {
    for (let i = 0; i < 120; i++) {
      const info = await tauri.core.invoke("backend_info");
      if (info.url) { base = info.url; token = info.token; return info; }
      if (info.error) { startError = info.error; return info; }
      await sleep(250);
    }
    startError = "The data service didn't start within 30 seconds.";
    return { error: startError };
  }
  const p = new URLSearchParams(location.search);
  base = p.get("api") || "http://127.0.0.1:8765";
  token = p.get("token") || "devtoken";
  return { url: base };
}

export function error() { return startError; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  if (!base) throw new Error(startError || "Data service not available");
  const res = await fetch(base + "/api/" + path, {
    method,
    headers: { "X-Pitwall-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.auth = !!data.auth || res.status === 401;
    throw e;
  }
  return data;
}

export const get = (path) => call("GET", path);
export const post = (path, body) => call("POST", path, body || {});

// Start a background job and wait for it, reporting progress lines.
export async function runJob(path, body, onProgress) {
  const start = await post(path, body);
  if (!start.job) return start;
  for (;;) {
    await sleep(400);
    const j = await get("job/" + start.job);
    onProgress && onProgress(j.progress || []);
    if (j.state === "done") return j.result;
    if (j.state === "error") {
      const e = new Error(j.error);
      e.auth = !!j.auth;
      throw e;
    }
  }
}

// Per-session cache of view data, so switching tabs is instant.
const cache = new Map();
export async function sessionData(key, view, params = "") {
  const id = `${key}/${view}?${params}`;
  if (!cache.has(id)) {
    cache.set(id, get(`s/${key}/${view}${params ? "?" + params : ""}`).catch((e) => {
      cache.delete(id);
      throw e;
    }));
  }
  return cache.get(id);
}
