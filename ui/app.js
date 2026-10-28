// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import * as api from "./lib/api.js";
import { C, esc, h, readable } from "./lib/format.js";
import * as overview from "./views/overview.js";
import * as laps from "./views/laps.js";
import * as telemetry from "./views/telemetry.js";
import * as track from "./views/track.js";
import * as strategy from "./views/strategy.js";
import * as corners from "./views/corners.js";
import * as straights from "./views/straights.js";
import * as longruns from "./views/longruns.js";
import * as engines from "./views/engines.js";
import * as season from "./views/season.js";

const VIEWS = [
  ["overview", "Overview", overview], ["laps", "Lap times", laps],
  ["telemetry", "Telemetry", telemetry], ["track", "Track map", track],
  ["strategy", "Strategy", strategy], ["corners", "Corners", corners],
  ["straights", "Straights & energy", straights], ["longruns", "Long runs", longruns],
  ["engines", "Power units", engines], ["season", "Season", season],
];
const SESSIONLESS = new Set(["season"]);
// the tab bar is split in two: what happened in the session, then how the cars compare
const GROUPS = { overview: "Session", corners: "Car analysis" };

const S = {
  years: [], demoYear: 9999, year: null, events: [], round: null, sessionName: null,
  key: null, ov: null, selected: [], view: "overview", auth: { signed_in: false },
  health: null, loading: null, cleanup: null,
};

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- shell

function shell() {
  document.getElementById("app").replaceChildren(
    h(`<header class="top">
        <div class="brand"><span class="mark">P</span>PITWALL</div>
        <div class="crumb" id="crumb"><span class="muted">No session loaded</span></div>
        <div class="spacer"></div>
        <span id="authpill"></span>
        <button class="iconbtn" id="authbtn" title="F1 TV account">Account</button>
      </header>`),
    h(`<main class="body">
        <aside class="side">
          <section>
            <h3>Season</h3>
            <div class="row"><select id="year" style="flex:1"></select></div>
          </section>
          <section>
            <h3>Event</h3>
            <div class="events" id="events"></div>
            <div class="sessions" id="sessions"></div>
          </section>
          <div class="drivers" id="drivers"></div>
        </aside>
        <div class="content">
          <nav class="tabs" id="tabs"></nav>
          <div class="view" id="view"></div>
        </div>
      </main>`),
  );
  $("#year").addEventListener("change", (e) => selectYear(+e.target.value));
  $("#authbtn").addEventListener("click", openAuth);
}

function renderTabs() {
  const nav = $("#tabs");
  const items = [];
  VIEWS.forEach(([id, label]) => {
    const group = GROUPS[id];
    if (group) {
      if (items.length) items.push(h(`<span class="sep"></span>`));
      items.push(h(`<span class="group">${group}</span>`));
    }
    const b = h(`<button>${label}</button>`);
    b.classList.toggle("on", S.view === id);
    b.disabled = !S.key && !SESSIONLESS.has(id);
    b.onclick = () => { S.view = id; renderTabs(); renderView(); };
    items.push(b);
  });
  nav.replaceChildren(...items);
}

function renderAuthPill() {
  const p = $("#authpill");
  if (S.key && S.ov && S.ov.meta.demo) {
    p.innerHTML = `<span class="pill demo"><span class="dot"></span>Demo data</span>`;
  } else if (S.auth.signed_in) {
    p.innerHTML = `<span class="pill ok"><span class="dot"></span>F1 TV ${esc(S.auth.product || "")}</span>`;
  } else if (S.auth.expired) {
    p.innerHTML = `<span class="pill warn"><span class="dot"></span>Sign-in expired</span>`;
  } else {
    p.innerHTML = `<span class="pill"><span class="dot"></span>Not signed in</span>`;
  }
}

function renderCrumb() {
  const c = $("#crumb");
  if (!S.ov) { c.innerHTML = `<span class="muted">No session loaded</span>`; return; }
  const m = S.ov.meta;
  const yr = m.demo ? "Demo" : m.year;
  c.innerHTML = `<span>${yr}</span><span class="sep">/</span><span>R${m.round}</span>
    <span class="sep">/</span><b>${esc(m.event)}</b><span class="sep">/</span><span>${esc(m.session)}</span>`;
}

// ---------------------------------------------------------------- sidebar

async function selectYear(year) {
  S.year = year;
  S.events = [];
  renderEvents();
  try {
    const r = await api.get(`schedule?year=${year}`);
    S.events = r.events;
  } catch (e) {
    $("#events").innerHTML = `<div class="error" style="padding:6px">${esc(e.message)}</div>`;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const past = S.events.filter((e) => e.date && e.date <= today);
  S.round = (past.at(-1) || S.events[0] || {}).round ?? null;
  renderEvents();
  if (S.view === "season") renderView();
}

function renderEvents() {
  const el = $("#events");
  const today = new Date().toISOString().slice(0, 10);
  el.replaceChildren(...S.events.map((e) => {
    const d = h(`<div class="event"><span class="rnd">R${e.round}</span>
      <span>${esc(e.name.replace(" Grand Prix", " GP"))}</span>
      <span class="date">${e.date ? e.date.slice(5) : ""}</span></div>`);
    d.classList.toggle("sel", e.round === S.round);
    d.classList.toggle("future", !!e.date && e.date > today);
    d.onclick = () => { S.round = e.round; renderEvents(); };
    return d;
  }));
  const sel = el.querySelector(".sel");
  if (sel) sel.scrollIntoView({ block: "nearest" });
  const ev = S.events.find((e) => e.round === S.round);
  const now = new Date();
  $("#sessions").replaceChildren(...(ev ? ev.sessions : []).map((s) => {
    const b = h(`<button class="btn small">${esc(s.name.replace("Practice ", "FP"))}</button>`);
    const started = !s.date || new Date(s.date) <= now || S.year === S.demoYear;
    b.disabled = !started;
    b.title = started ? `Load ${s.name}` : "Hasn't happened yet";
    b.classList.toggle("on", S.ov && S.ov.meta.round === ev.round && S.ov.meta.session === s.name
      && (S.ov.meta.year === S.year || S.ov.meta.demo));
    b.onclick = () => loadSession(S.year, ev.round, s.name);
    return b;
  }));
}

function renderDrivers() {
  const el = $("#drivers");
  if (!S.ov) { el.replaceChildren(); return; }
  const byAbbr = Object.fromEntries(S.ov.drivers.map((d) => [d.abbr, d]));
  const pos = Object.fromEntries((S.ov.results || []).map((r) => [r.abbr, r.position]));
  const head = h(`<div class="head"><h3>Drivers</h3><span><a id="selnone">clear</a></span></div>`);
  head.querySelector("#selnone").onclick = () => setSelected([]);
  el.replaceChildren(head, ...S.ov.order.filter((a) => byAbbr[a]).map((a) => {
    const d = byAbbr[a];
    const row = h(`<div class="drv" title="${esc(d.name)} — ${esc(d.team)}">
      <span class="pos">${pos[a] ?? ""}</span><span class="bar" style="background:${readable(d.color)}"></span>
      <span class="abbr">${esc(a)}</span><span class="team">${esc(d.team)}</span><span class="chk"></span></div>`);
    row.classList.toggle("sel", S.selected.includes(a));
    row.onclick = () => {
      const s = S.selected.includes(a) ? S.selected.filter((x) => x !== a) : [...S.selected, a];
      setSelected(s);
    };
    return row;
  }));
}

function setSelected(list) {
  S.selected = list;
  renderDrivers();
  renderView({ selectionOnly: true });
}

// ---------------------------------------------------------------- sessions

async function loadSession(year, round, name) {
  S.loading = { label: name, progress: [] };
  S.view = S.key ? S.view : "overview";
  renderTabs();
  renderView();
  try {
    const r = await api.runJob("load", { year, round, session: name }, (p) => {
      S.loading.progress = p;
      const log = document.querySelector(".progress-log");
      if (log) { log.textContent = p.slice(-8).join("\n"); }
    });
    S.key = r.session;
    S.ov = await api.sessionData(S.key, "overview");
    const order = S.ov.order;
    S.selected = order.slice(0, 2);
  } catch (e) {
    S.loading = null;
    if (e.auth) { openAuth(); }
    $("#view").replaceChildren(h(`<div class="empty"><div class="welcome">
      <h1>Couldn't load ${esc(name)}</h1><p class="note error">${esc(e.message)}</p></div></div>`));
    return;
  }
  S.loading = null;
  renderCrumb(); renderAuthPill(); renderEvents(); renderDrivers(); renderTabs(); renderView();
}

// colours: team colour, the team's second driver dashed
function styleFor() {
  const seen = {};
  const map = {};
  for (const d of S.ov ? S.ov.drivers : []) {
    const n = (seen[d.team] = (seen[d.team] || 0) + 1);
    map[d.abbr] = { color: readable(d.color), dash: n > 1, team: d.team, name: d.name };
  }
  return map;
}

function ctx() {
  const styles = styleFor();
  return {
    key: S.key, ov: S.ov, selected: S.selected, year: S.year, demoYear: S.demoYear,
    events: S.events, styles,
    color: (a) => (styles[a] || {}).color || C.gray,
    dash: (a) => !!(styles[a] || {}).dash,
    teamColor: (team) => {
      const d = S.ov && S.ov.drivers.find((x) => x.team === team);
      return d ? readable(d.color) : C.gray;
    },
    select: setSelected,
    onAuthNeeded: openAuth,
    // load another session of the same weekend (e.g. Qualifying from a race view)
    openSession: (name) => S.ov && loadSession(S.ov.meta.year, S.ov.meta.round, name),
  };
}

// ---------------------------------------------------------------- views

let lastView = null;
async function renderView(opts = {}) {
  const el = $("#view");
  if (S.loading) {
    if (S.cleanup) { S.cleanup(); S.cleanup = null; }
    el.replaceChildren(h(`<div class="empty"><div class="loading">
      <div class="row"><div class="spinner"></div><span>Loading ${esc(S.loading.label)}…</span></div>
      <div class="note">The first load of a session downloads its timing and telemetry and can take a
      minute; after that it's read from the cache.</div>
      <pre class="progress-log"></pre></div></div>`));
    return;
  }
  if (!S.key && !SESSIONLESS.has(S.view)) { welcome(el); return; }
  const mod = VIEWS.find((v) => v[0] === S.view)[2];
  if (opts.selectionOnly && lastView === S.view && mod.onSelection) {
    mod.onSelection(ctx());
    return;
  }
  if (S.cleanup) { S.cleanup(); S.cleanup = null; }
  lastView = S.view;
  // each render draws into its own container, so a slow render that a newer one
  // has replaced can't draw into the new one's page
  const gen = ++renderGen;
  const host = document.createElement("div");
  el.replaceChildren(host);
  el.scrollTop = 0;
  try {
    const cleanup = (await mod.render(host, ctx())) || null;
    if (gen !== renderGen) { if (cleanup) cleanup(); return; }
    S.cleanup = cleanup;
  } catch (e) {
    if (gen !== renderGen) return;
    console.error(e);
    el.replaceChildren(h(`<div class="card"><span class="error">${esc(e.message)}</span></div>`));
    if (e.auth) openAuth();
  }
}
let renderGen = 0;

function welcome(el) {
  const ff = S.health && S.health.fastf1;
  el.replaceChildren(h(`<div class="empty"><div class="welcome">
    <h1>Pick a session</h1>
    <p class="note">Choose a season and an event on the left, then a session. Pitwall loads F1's timing
    and car telemetry through <b>FastF1</b> and breaks it down: lap times, telemetry traces, track maps,
    tyre strategy, and where each car gains its time.</p>
    ${S.auth.signed_in ? "" : `<p class="note">F1's timing service needs an <b>F1 TV</b> account. Sign in
    once and the session stays valid for a while. Or try the <b>demo</b>: an invented race weekend to
    explore every view.</p>`}
    ${ff ? "" : `<p class="warnbox">FastF1 isn't installed for the data service, so only the demo works.
    ${esc((S.health && S.health.fastf1_error) || "")}</p>`}
    <div class="actions">
      ${S.auth.signed_in || !ff ? "" : `<button class="btn primary" id="w-signin">Sign in to F1 TV</button>`}
      <button class="btn" id="w-demo">Open the demo</button>
    </div></div></div>`));
  const si = el.querySelector("#w-signin");
  if (si) si.onclick = openAuth;
  el.querySelector("#w-demo").onclick = async () => {
    $("#year").value = String(S.demoYear);
    await selectYear(S.demoYear);
    loadSession(S.demoYear, 1, "Race");
  };
}

// ---------------------------------------------------------------- sign-in

function openAuth() {
  if (document.querySelector(".modal-back")) return;
  const back = h(`<div class="modal-back"><div class="modal">
    <h2>F1 TV account</h2>
    <div class="note" id="a-status"></div>
    <form id="a-form">
      <label>Email</label><input type="text" id="a-user" autocomplete="username">
      <label>Password</label><input type="password" id="a-pass" autocomplete="current-password">
      <p class="note muted" style="font-size:12.5px">Your password goes straight to F1's sign-in through
      FastF1 and isn't stored. FastF1 keeps the session token it gets back, so you only sign in again when
      it expires.</p>
      <div class="error" id="a-err"></div>
      <div class="actions">
        <button type="button" class="btn" id="a-out">Sign out</button>
        <span style="flex:1"></span>
        <button type="button" class="btn" id="a-cancel">Close</button>
        <button type="submit" class="btn primary" id="a-go">Sign in</button>
      </div>
    </form></div></div>`);
  document.body.append(back);
  const st = back.querySelector("#a-status");
  st.innerHTML = S.auth.signed_in
    ? `Signed in (${esc(S.auth.product || "F1 TV")}), valid until ${esc((S.auth.expires || "").replace("T", " "))}.`
    : S.auth.expired ? "Your sign-in has expired." : "Not signed in.";
  back.querySelector("#a-out").style.display = S.auth.signed_in || S.auth.expired ? "" : "none";
  const close = () => back.remove();
  back.querySelector("#a-cancel").onclick = close;
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  back.querySelector("#a-out").onclick = async () => {
    S.auth = await api.post("auth/signout");
    renderAuthPill(); close(); if (!S.key) renderView();
  };
  back.querySelector("#a-form").onsubmit = async (e) => {
    e.preventDefault();
    const go = back.querySelector("#a-go");
    go.disabled = true; go.textContent = "Signing in…";
    back.querySelector("#a-err").textContent = "";
    try {
      S.auth = await api.post("auth/signin", {
        username: back.querySelector("#a-user").value.trim(),
        password: back.querySelector("#a-pass").value,
      });
      renderAuthPill(); close(); if (!S.key) renderView();
    } catch (err) {
      back.querySelector("#a-err").textContent = err.message;
      go.disabled = false; go.textContent = "Sign in";
    }
  };
  back.querySelector("#a-user").focus();
}

// ---------------------------------------------------------------- start

async function start() {
  shell();
  renderTabs();
  $("#view").replaceChildren(h(`<div class="empty"><div class="loading"><div class="row">
    <div class="spinner"></div><span>Starting the data service…</span></div></div></div>`));
  const info = await api.init();
  if (info.error) {
    $("#view").replaceChildren(h(`<div class="empty"><div class="welcome"><h1>The data service didn't start</h1>
      <p class="note error">${esc(info.error)}</p>
      <p class="note">Pitwall needs Python 3.10+ with FastF1 installed:
      <b>pip install -r backend/requirements.txt</b>. If Python isn't on your PATH as <b>python</b>,
      set <b>PITWALL_PYTHON</b> to its full path.</p></div></div>`));
    return;
  }
  try {
    S.health = await api.get("health");
    const y = await api.get("years");
    S.years = y.years; S.demoYear = y.demo;
    S.auth = await api.get("auth/status").catch(() => ({ signed_in: false }));
  } catch (e) {
    $("#view").replaceChildren(h(`<div class="card error">${esc(e.message)}</div>`));
    return;
  }
  const ys = $("#year");
  ys.replaceChildren(...S.years.map((y) => h(`<option value="${y}">${y}</option>`)),
    h(`<option value="${S.demoYear}">Demo</option>`));
  const startYear = S.health.fastf1 ? S.years[0] : S.demoYear;
  ys.value = String(startYear);
  renderAuthPill();
  renderView();
  await selectYear(startYear);
  const auto = new URLSearchParams(location.search).get("load");
  if (auto) {  // development helper: ?load=9999,1,Race&view=telemetry
    const [y, r, ...s] = auto.split(",");
    if (+y !== S.year) { ys.value = y; await selectYear(+y); }
    S.round = +r; renderEvents();
    await loadSession(+y, +r, s.join(","));
    const v = new URLSearchParams(location.search).get("view");
    if (v && VIEWS.some((x) => x[0] === v)) { S.view = v; renderTabs(); renderView(); }
    const sel = new URLSearchParams(location.search).get("sel");
    if (sel) setSelected(sel.split(","));
  }
}

start();
