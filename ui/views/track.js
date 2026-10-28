// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import * as api from "../lib/api.js";
import { drawTrack } from "../lib/charts.js";
import { C, GEAR_COLORS, esc, h, lapTime, ramp } from "../lib/format.js";

let mode = "speed";
let who = null;
let count = 25;

const MODES = [["speed", "Speed"], ["gear", "Gear"], ["throttle", "Throttle"], ["brake", "Braking"],
  ["mini", "Mini-sectors"]];

export async function render(el, ctx) {
  const sel = ctx.selected.length ? ctx.selected : ctx.ov.order.slice(0, 1);
  if (!sel.includes(who)) who = sel[0];
  const card = h(`<div class="grid g-main">
    <div class="card"><div class="title"><h2>Track map</h2><span class="sub" id="tsub"></span>
      <div class="tools">${MODES.map(([k, l]) => `<button class="chip ${k === mode ? "on" : ""}" data-m="${k}">${l}</button>`).join("")}</div></div>
      <div class="row" style="gap:6px;margin-bottom:8px" id="who"></div>
      <canvas class="track" id="map"></canvas>
      <div id="legend" style="margin-top:10px"></div></div>
    <div class="grid" style="align-content:start" id="side"></div></div>`);
  el.append(card);
  card.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { mode = b.dataset.m; ctx.select(ctx.selected); }));

  const whoEl = card.querySelector("#who");
  const legend = card.querySelector("#legend");
  const side = card.querySelector("#side");
  const canvas = card.querySelector("#map");

  if (mode === "mini") {
    const drivers = sel.slice(0, 8);
    whoEl.innerHTML = `<span class="muted">Fastest laps of the selected drivers, split into</span>
      <select id="cnt">${[10, 15, 25, 40, 60].map((n) => `<option ${n === count ? "selected" : ""}>${n}</option>`).join("")}</select>
      <span class="muted">equal parts</span>`;
    card.querySelector("#cnt").onchange = (e) => { count = +e.target.value; ctx.select(ctx.selected); };
    const m = await api.sessionData(ctx.key, "minisectors", `drivers=${drivers.join(",")}&count=${count}`);
    if (!m.available) { legend.textContent = "No telemetry."; return; }
    const colors = [];
    let k = 0;
    for (let i = 0; i < m.distance.length - 1; i++) {
      while (k < m.sectors.length - 1 && m.distance[i] > m.sectors[k].to) k++;
      colors.push(ctx.color(m.sectors[k].fastest));
    }
    drawTrack(canvas, { x: m.x, y: m.y, rotation: m.rotation, colors, corners: m.corners, width: 7, height: 560 });
    card.querySelector("#tsub").textContent = "who was quickest through each part";
    legend.innerHTML = `<div class="legend">${drivers.map((a) => `<span><i style="background:${ctx.color(a)};height:8px"></i>
      ${a} <span class="muted">${m.won[a] ?? 0}</span></span>`).join("")}</div>`;
    const totals = Object.fromEntries(drivers.map((a) => [a, m.sectors.reduce((s, x) => s + (x.times[a] ?? 0), 0)]));
    const fastest = Math.min(...Object.values(totals));
    side.innerHTML = `<div class="card"><div class="title"><h2>Parts won</h2></div>
      <table class="t"><thead><tr><th>Driver</th><th class="num">Won</th><th class="num">Lap</th><th class="num">Gap</th></tr></thead><tbody>
      ${drivers.sort((a, b) => (m.won[b] ?? 0) - (m.won[a] ?? 0)).map((a) => `<tr><td><div class="teamcell"><i style="background:${ctx.color(a)}"></i><b>${a}</b></div></td>
        <td class="num">${m.won[a] ?? 0}</td><td class="num">${lapTime(totals[a])}</td>
        <td class="num muted">${totals[a] === fastest ? "" : "+" + (totals[a] - fastest).toFixed(3)}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="card note" style="font-size:12.5px">Each part is the same length. A team that wins the
      long parts after slow corners but loses the fast sweepers usually has traction and power on its side
      rather than downforce.</div>${Object.keys(m.shifted || {}).length ? `<div class="card note muted" style="font-size:12.5px">
      ${Object.entries(m.shifted).map(([a, v]) => `<b>${a}</b>'s telemetry is cut ${Math.abs(v)} m round the lap from <b>${sel[0]}</b>'s`).join(", ")}
      (a timing-feed quirk), so it's turned to line up by track position before the parts are cut.</div>` : ""}`;
    return;
  }

  whoEl.innerHTML = sel.map((a) => `<button class="chip ${a === who ? "on" : ""}" data-w="${a}" style="${a === who ? `border-color:${ctx.color(a)};color:${ctx.color(a)}` : ""}">${a}</button>`).join("");
  whoEl.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => { who = b.dataset.w; ctx.select(ctx.selected); }));
  const t = await api.sessionData(ctx.key, "map", `driver=${who}`);
  if (!t.available) { legend.textContent = "No telemetry for this lap."; return; }
  const sp = t.Speed;
  const lo = Math.min(...sp), hi = Math.max(...sp);
  let colors, leg;
  if (mode === "speed") {
    colors = sp.map((v) => ramp((v - lo) / (hi - lo || 1)));
    leg = `<div class="row" style="gap:10px"><span class="muted">${lo.toFixed(0)} km/h</span>
      <div style="flex:1;height:8px;border-radius:4px;background:linear-gradient(90deg,${[0, .2, .4, .6, .8, 1].map(ramp).join(",")})"></div>
      <span class="muted">${hi.toFixed(0)} km/h</span></div>`;
  } else if (mode === "gear") {
    colors = t.nGear.map((g) => GEAR_COLORS[Math.max(0, Math.min(8, g))]);
    leg = `<div class="legend">${[1, 2, 3, 4, 5, 6, 7, 8].map((g) => `<span><i style="background:${GEAR_COLORS[g]};height:8px"></i>${g}</span>`).join("")}</div>`;
  } else if (mode === "throttle") {
    colors = t.Throttle.map((v) => (v >= 97 ? C.green : v <= 5 ? C.bg2 : ramp(0.15 + (v / 100) * 0.3)));
    leg = `<div class="legend"><span><i style="background:${C.green};height:8px"></i>Full throttle</span>
      <span><i style="background:${ramp(0.3)};height:8px"></i>Partial</span><span><i style="background:${C.bg2};height:8px"></i>Off</span></div>`;
  } else {
    colors = t.Brake.map((b) => (b ? C.red : C.bg3));
    leg = `<div class="legend"><span><i style="background:${C.red};height:8px"></i>Braking</span></div>`;
  }
  drawTrack(canvas, { x: t.x, y: t.y, rotation: t.rotation, colors, corners: t.corners, width: 7, height: 560 });
  legend.innerHTML = leg;
  const laps = (await api.sessionData(ctx.key, "laps")).laps[who] || [];
  const lap = laps.find((l) => l.n === t.lap);
  card.querySelector("#tsub").textContent = `${who} · lap ${t.lap} · ${lapTime(lap && lap.t)}`;

  // lap statistics
  const n = t.distance.length;
  const span = (i) => (i < n - 1 ? t.distance[i + 1] - t.distance[i] : 0);
  const total = t.distance[n - 1] || 1;
  const pct = (f) => (100 * t.distance.reduce((s, _, i) => s + (f(i) ? span(i) : 0), 0)) / total;
  let shifts = 0;
  for (let i = 1; i < n; i++) if (t.nGear[i] !== t.nGear[i - 1]) shifts++;
  const stat = (k, v) => `<div class="stat"><span class="k">${k}</span><span class="v" style="font-size:18px">${v}</span></div>`;
  side.innerHTML = `<div class="card"><div class="title"><h2>This lap</h2></div>
    <div class="grid g2">${stat("Top speed", hi.toFixed(0) + " km/h")}${stat("Slowest point", lo.toFixed(0) + " km/h")}
    ${stat("Full throttle", pct((i) => t.Throttle[i] >= 97).toFixed(0) + "%")}${stat("Braking", pct((i) => t.Brake[i] > 0).toFixed(0) + "%")}
    ${stat("Gear changes", shifts)}${stat("Avg speed", (t.Speed.reduce((s, v, i) => s + v * span(i), 0) / total).toFixed(0) + " km/h")}</div></div>
    <div class="card note" style="font-size:12.5px">Share of the lap by distance. Pick other drivers in the
    sidebar to switch between them; <b>Mini-sectors</b> compares them all at once.</div>`;
}
