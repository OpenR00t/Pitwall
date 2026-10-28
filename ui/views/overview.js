// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import { lineChart, destroyCharts } from "../lib/charts.js";
import { C, esc, h, lapTime, raceTime, gap } from "../lib/format.js";

export async function render(el, ctx) {
  const ov = ctx.ov;
  const m = ov.meta;
  const res = ov.results || [];
  const kind = m.type;
  const charts = [];
  const drv = Object.fromEntries(ov.drivers.map((d) => [d.abbr, d]));
  const name = (a) => `<div class="teamcell"><i style="background:${ctx.color(a)}"></i><b>${esc(a)}</b>
    <span class="muted">${esc((drv[a] || {}).name || "")}</span></div>`;

  const fastest = res.filter((r) => r.fastest != null).sort((a, b) => a.fastest - b.fastest)[0];
  const leader = res[0];
  const w = ov.weather;
  const stat = (k, v, sub = "") => `<div class="card stat"><span class="k">${k}</span>
    <span class="v">${v}</span><span class="muted">${sub}</span></div>`;

  let table;
  if (kind === "R" || kind === "S") {
    const winner = res[0] && res[0].time;
    table = `<table class="t"><thead><tr><th class="num">Pos</th><th>Driver</th><th>Team</th>
      <th class="num">Grid</th><th class="num">Time / gap</th><th>Status</th><th class="num">Pts</th>
      <th class="num">Best lap</th></tr></thead><tbody>${res.map((r, i) => {
        const moved = r.grid && r.position ? r.grid - r.position : 0;
        const mv = moved > 0 ? `<span class="up">▲${moved}</span>` : moved < 0 ? `<span class="down">▼${-moved}</span>` : "";
        const t = i === 0 ? raceTime(winner) : r.time != null ? gap(r.time) : "";
        const best = r.fastest != null && fastest && r.abbr === fastest.abbr;
        return `<tr><td class="num">${r.classified ?? r.position ?? ""}</td><td>${name(r.abbr)}</td>
          <td class="muted">${esc((drv[r.abbr] || {}).team || "")}</td>
          <td class="num">${r.grid || "PL"} ${mv}</td><td class="num">${t}</td>
          <td class="muted">${esc(r.status || "")}</td><td class="num">${r.points ?? ""}</td>
          <td class="num ${best ? "ob" : ""}">${lapTime(r.fastest)}</td></tr>`;
      }).join("")}</tbody></table>`;
  } else if (kind === "Q" || kind === "SQ") {
    const best = (q) => Math.min(...res.map((r) => r[q] ?? Infinity));
    const bq = { q1: best("q1"), q2: best("q2"), q3: best("q3") };
    const cell = (r, q) => `<td class="num ${r[q] === bq[q] ? "ob" : ""}">${r[q] != null ? lapTime(r[q]) : ""}</td>`;
    const pole = res[0] && (res[0].q3 ?? res[0].q2 ?? res[0].q1);
    table = `<table class="t"><thead><tr><th class="num">Pos</th><th>Driver</th><th>Team</th>
      <th class="num">Q1</th><th class="num">Q2</th><th class="num">Q3</th><th class="num">Gap</th></tr></thead>
      <tbody>${res.map((r) => {
        const b = r.q3 ?? r.q2 ?? r.q1;
        return `<tr><td class="num">${r.position ?? ""}</td><td>${name(r.abbr)}</td>
          <td class="muted">${esc((drv[r.abbr] || {}).team || "")}</td>
          ${cell(r, "q1")}${cell(r, "q2")}${cell(r, "q3")}
          <td class="num muted">${b != null && pole != null && b !== pole ? gap(b - pole) : ""}</td></tr>`;
      }).join("")}</tbody></table>`;
  } else {
    const best = res[0] && res[0].fastest;
    table = `<table class="t"><thead><tr><th class="num">Pos</th><th>Driver</th><th>Team</th>
      <th class="num">Best lap</th><th class="num">Gap</th><th class="num">On lap</th></tr></thead>
      <tbody>${res.map((r) => `<tr><td class="num">${r.position ?? ""}</td><td>${name(r.abbr)}</td>
        <td class="muted">${esc((drv[r.abbr] || {}).team || "")}</td>
        <td class="num ${r.fastest === best ? "ob" : ""}">${lapTime(r.fastest)}</td>
        <td class="num muted">${r.fastest != null && best != null && r.fastest !== best ? gap(r.fastest - best) : ""}</td>
        <td class="num muted">${r.fastest_lap ?? ""}</td></tr>`).join("")}</tbody></table>`;
  }

  // FastF1 sometimes lists two drivers in one place after a post-session
  // penalty or disqualification; the source doesn't say which moved
  const seen = {}, clash = new Set();
  for (const r of res) if (r.position) { if (seen[r.position]) clash.add(r.position); seen[r.position] = 1; }
  if (clash.size) {
    const ps = [...clash].sort((x, y) => x - y);
    table += `<div class="note muted" style="font-size:12.5px;margin-top:8px">The published results list more than one driver in
      ${ps.length > 1 ? `positions ${ps.slice(0, -1).join(", ")} and ${ps.at(-1)}` : `position ${ps[0]}`}. That usually follows a penalty or disqualification decided after the session,
      which the timing data doesn't record, so the positions are shown as published.</div>`;
  }
  const last = (a) => (a && a.length ? a[a.length - 1] : null);
  const rc = (ov.race_control || []).filter((x) => x.message);
  el.append(h(`<div class="grid">
    <div class="grid g3" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      ${stat(kind === "R" || kind === "S" ? "Winner" : kind === "FP" ? "Fastest" : "Pole",
        leader ? esc(leader.abbr) : "—", leader ? esc((drv[leader.abbr] || {}).team || "") : "")}
      ${stat("Fastest lap", fastest ? lapTime(fastest.fastest) : "—",
        fastest ? `${esc(fastest.abbr)} · lap ${fastest.fastest_lap}` : "")}
      ${stat("Track / air", w ? `${last(w.TrackTemp)?.toFixed(1)}° / ${last(w.AirTemp)?.toFixed(1)}°` : "—",
        w && w.rain && w.rain.some(Boolean) ? "Rain during the session" : "Dry")}
      ${stat("Laps", ov.total_laps || "—", m.demo ? "Invented data" : esc(m.circuit || ""))}
    </div>
    <div class="grid g-main">
      <div class="card"><div class="title"><h2>Classification</h2>
        <span class="sub">${esc(m.session)}</span></div><div class="scroll-y" style="max-height:none">${table}</div></div>
      <div class="grid" style="align-content:start">
        <div class="card"><div class="title"><h2>Weather</h2><span class="sub">°C over the session</span></div>
          <div class="legend"><span><i style="background:${C.orange}"></i>Track</span>
            <span><i style="background:${C.blue}"></i>Air</span></div><div id="wx"></div></div>
        <div class="card"><div class="title"><h2>Race control</h2></div>
          <div class="rc scroll-y" style="max-height:340px">${rc.length ? rc.map((x) => `<span class="lap">${x.lap != null ? "L" + x.lap : ""}</span>
            <span class="msg ${/flag/i.test(x.category || "") ? "flag" : /safety/i.test(x.category || "") ? "sc" : ""}">${esc(x.message)}</span>`).join("")
            : `<span></span><span class="muted">No messages</span>`}</div></div>
      </div>
    </div></div>`));

  if (w && w.time && w.time.length > 1) {
    charts.push(lineChart(el.querySelector("#wx"), {
      x: w.time.map((t) => t / 60), height: 150, xFmt: (v) => `${v.toFixed(0)}m`,
      series: [{ label: "Track", values: w.TrackTemp, color: C.orange },
        { label: "Air", values: w.AirTemp, color: C.blue }],
    }));
  }
  return () => destroyCharts(charts);
}
