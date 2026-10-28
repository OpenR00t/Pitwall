// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
// The "findings" table each car-analysis view leads with: one row per team,
// its rank on a few measures, and a short reading of what those ranks suggest.

import { C, esc } from "./format.js";

export const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

/** {team: value} -> {team: rank}, 1 = best; equal values share a rank. */
export function rank(values, { lowerBetter = false } = {}) {
  const list = Object.entries(values).filter(([, v]) => v != null && Number.isFinite(v))
    .sort((a, b) => (lowerBetter ? a[1] - b[1] : b[1] - a[1]));
  const out = {};
  list.forEach(([t, v], i) => {
    out[t] = i > 0 && v === list[i - 1][1] ? out[list[i - 1][0]] : i + 1;
  });
  return out;
}

/** Rank bands: the top and bottom third of the field. */
export function bands(n) {
  const third = Math.max(1, Math.floor(n / 3));
  return {
    top: (r) => r != null && r <= third,
    bottom: (r) => r != null && r > n - third,
    third,
  };
}

/** A table cell showing a rank coloured by band, with the raw value beside it. */
export function rankCell(r, n, detail = "") {
  if (r == null) return `<td class="num muted">—</td>`;
  const b = bands(n);
  const color = b.top(r) ? C.green : b.bottom(r) ? C.red : C.fg1;
  return `<td class="num"><span style="color:${color}">${ord(r)}</span>${detail ? ` <span class="muted">${detail}</span>` : ""}</td>`;
}

/*
 * findingsCard({
 *   title, sub,
 *   columns: ["Top speed", ...],
 *   rows: [{ team, color, cells: ["<td>…</td>", ...], tag, text }],
 *   note: optional html under the table,
 * })
 */
export function findingsCard({ title = "Findings", sub = "", first = "Team", columns, rows, note = "" }) {
  return `<div class="card"><div class="title"><h2>${title}</h2><span class="sub">${sub}</span></div>
    <div style="overflow-x:auto"><table class="t"><thead><tr><th>${first}</th>${columns.map((c) => `<th class="num">${c}</th>`).join("")}<th>What it suggests</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><div class="teamcell"><i style="background:${r.color}"></i>${esc(r.team)}</div></td>
      ${r.cells.join("")}
      <td style="white-space:normal;min-width:300px;line-height:1.45">${r.tag ? `<b style="color:var(--fg1)">${r.tag}</b>` : ""}${r.text ? ` <span class="muted" style="font-family:var(--font-read)">· ${r.text}</span>` : ""}</td></tr>`).join("")}
    </tbody></table></div>${note ? `<div class="note muted" style="font-size:12.5px;margin-top:8px">${note}</div>` : ""}</div>`;
}

/** "A", "A and B", "A, B and C" in bold. */
export function names(list) {
  const b = list.map((t) => `<b>${esc(t)}</b>`);
  return b.length > 1 ? `${b.slice(0, -1).join(", ")} and ${b.at(-1)}` : b[0] || "";
}

/** A warning for sessions run wholly or partly in the wet, or empty string. */
export function conditionsNote(ctx) {
  const w = (ctx.ov && ctx.ov.meta && ctx.ov.meta.wet_share) || 0;
  if (w >= 0.5) {
    return `<div class="card warnbox"><span class="note" style="max-width:none">Most of this session was run on
      <b>intermediate or wet tyres</b>. Lap times, corner speeds and top speeds then depend on how much water is on
      the track at each moment, so these comparisons say more about the conditions than about the cars.</span></div>`;
  }
  if (w >= 0.1) {
    return `<div class="card warnbox"><span class="note" style="max-width:none">Part of this session was wet
      (${Math.round(w * 100)}% of laps on intermediate or wet tyres). Fastest laps and clean stints mostly come from
      the dry running, but a track that is still drying can favour whoever ran last.</span></div>`;
  }
  return "";
}

/**
 * A warning for car comparisons made outside qualifying, with a button that
 * opens the weekend's qualifying when it's loaded. Returns { html, wire(el) }.
 * `detail` says what blurs this view's numbers in a race or practice session.
 */
export function sessionBanner(ctx, detail) {
  const meta = ctx.ov.meta;
  if (meta.type === "Q" || meta.type === "SQ") return { html: "", wire() {} };
  const race = meta.type === "R" || meta.type === "S";
  const ev = (ctx.events || []).find((e) => e.round === meta.round);
  const qName = ev && ev.sessions.map((s) => (typeof s === "string" ? s : s.name)).find((s) => s === "Qualifying");
  const html = `<div class="card warnbox" style="display:flex;gap:14px;align-items:center">
    <span class="note" style="max-width:none">This is ${race ? "a race" : "a practice session"}: ${detail}
      Qualifying puts every car on low fuel and new tyres, so it compares the cars more fairly.</span>
    ${qName ? `<button class="btn small" data-toq style="margin-left:auto;white-space:nowrap">Open Qualifying</button>` : ""}</div>`;
  return { html, wire(el) { const b = el.querySelector("[data-toq]"); if (b) b.onclick = () => ctx.openSession(qName); } };
}

/** A note naming teams with only one driver in the comparison, or "". */
export function loneNote(teams) {
  if (!teams || !teams.length) return "";
  return ` Only one ${teams.length > 1 ? "driver each" : "driver"} from ${names(teams)} counts here, while other teams get the better of two, so ${teams.length > 1 ? "they start" : "it starts"} at a small disadvantage.`;
}

/** What the lap check did to drivers' laps in the car analysis, or "". */
export function lapNote(notes) {
  const list = Object.entries(notes || {});
  if (!list.length) return "";
  return `<div class="card note muted" style="font-size:12.5px;max-width:none"><b>Laps checked.</b> Each driver's quickest lap is used
    unless its telemetry is cut short, measures the wrong length, isn't a racing lap or is cut from the wrong point of the lap:
    ${list.map(([a, t]) => `<b>${esc(a)}</b> ${esc(t)}`).join("; ")}.</div>`;
}
