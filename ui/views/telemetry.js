// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import * as api from "../lib/api.js";
import { destroyCharts, drawTrack, lineChart } from "../lib/charts.js";
import { C, esc, h, lapTime } from "../lib/format.js";

const MAX = 4;
const chosen = {}; // abbr -> lap number or "fastest"

const PANELS = [
  { key: "Speed", label: "Speed km/h", height: 250 },
  { key: "delta", label: "Delta s", height: 120, delta: true },
  { key: "Throttle", label: "Throttle %", height: 105, range: [-5, 105] },
  { key: "Brake", label: "Brake", height: 62, range: [-0.1, 1.15], stepped: true, splits: [0, 1] },
  { key: "nGear", label: "Gear", height: 110, range: [0.5, 8.5], stepped: true, splits: [1, 2, 3, 4, 5, 6, 7, 8] },
  { key: "RPM", label: "RPM", height: 110 },
  { key: "DRS", label: "DRS", height: 62, range: [-0.1, 1.15], stepped: true, splits: [0, 1] },
];

export async function render(el, ctx) {
  const sel = ctx.selected.slice(0, MAX);
  if (!sel.length) {
    el.append(h(`<div class="card note">Select up to ${MAX} drivers on the left. Their fastest laps are
      laid over each other by distance, with the time gap to the first driver.</div>`));
    return;
  }
  const { laps } = await api.sessionData(ctx.key, "laps");
  const spec = sel.map((a) => `${a}:${chosen[a] ?? "fastest"}`).join(",");
  const data = await api.sessionData(ctx.key, "compare", "laps=" + encodeURIComponent(spec));
  const charts = [];
  if (!data.available) {
    el.append(h(`<div class="card note">No telemetry for these laps.</div>`));
    return;
  }
  const series = data.series;
  const hasDRS = series.some((s) => (s.DRS || []).some((v) => v > 0));
  const offSync = series.filter((s) => s.length_off_pct != null && Math.abs(s.length_off_pct) > 1);
  const ref = series[0].abbr;
  const pickers = sel.map((a) => {
    const opts = (laps[a] || []).filter((l) => l.t != null).map((l) =>
      `<option value="${l.n}">L${l.n} ${lapTime(l.t)}${l.deleted ? " (deleted)" : ""}</option>`).join("");
    const cur = chosen[a] ?? "fastest";
    return `<label class="row" style="gap:6px"><span style="color:${ctx.color(a)};font-weight:700">${a}</span>
      <select data-lap="${a}"><option value="fastest" ${cur === "fastest" ? "selected" : ""}>Fastest lap</option>
      ${opts.replace(`value="${cur}"`, `value="${cur}" selected`)}</select></label>`;
  }).join("");

  el.append(h(`<div class="grid g-main">
    <div class="card" style="padding-right:8px">
      <div class="title"><h2>Telemetry</h2><span class="sub">by distance · drag to zoom, double-click to reset</span></div>
      <div class="row" style="flex-wrap:wrap;gap:14px;margin-bottom:10px">${pickers}</div>
      <div class="legend">${series.map((s) => `<span><i class="${ctx.dash(s.abbr) ? "dash" : ""}" style="background:${ctx.color(s.abbr)};color:${ctx.color(s.abbr)}"></i>
        ${s.abbr} L${s.lap} ${lapTime(s.laptime)}${s.abbr !== ref && s.laptime && series[0].laptime ? ` <span class="muted">(${(s.laptime - series[0].laptime >= 0 ? "+" : "") + (s.laptime - series[0].laptime).toFixed(3)})</span>` : ""}</span>`).join("")}</div>
      ${offSync.length ? `<div class="warnbox" style="margin:8px 0 4px"><span class="note" style="max-width:none">${offSync.map((s) =>
        `<b>${s.abbr}</b>'s lap measures ${Math.abs(s.length_off_pct).toFixed(1)}% ${s.length_off_pct > 0 ? "long" : "short"}`).join(", ")}:
        its speed and position data are out of sync (a timing-feed glitch), so ${offSync.length > 1 ? "their traces" : "its trace"} and the delta
        can be off within the lap. The lap time is still right; try another lap.</span></div>` : ""}
      ${(ctx.ov.meta.type === "R" || ctx.ov.meta.type === "S") && series.some((s) => s.lap === 1) ? `<div class="note muted" style="font-size:12.5px;margin:6px 0 4px">
        Lap 1 starts from the car's grid slot, not the line, and has no sector times, so it can't be lined up with other laps:
        its trace sits up to ~150 m out and the delta can be a few tenths off.</div>` : ""}
      ${series.some((s) => s.shifted_m) ? `<div class="note muted" style="font-size:12.5px;margin:6px 0 4px">${series.filter((s) => s.shifted_m).map((s) =>
        `<b>${s.abbr}</b>'s telemetry is cut ${Math.abs(s.shifted_m)} m round the lap from <b>${ref}</b>'s`).join(", ")}
        (a timing-feed quirk), so ${series.filter((s) => s.shifted_m).length > 1 ? "they've" : "it's"} been turned to line up with ${ref}'s by track position.
        Distances count from where ${ref}'s telemetry starts.</div>` : ""}
      <div id="panels"></div>
    </div>
    <div class="grid" style="align-content:start;position:sticky;top:0">
      <div class="card"><div class="title"><h2>Position</h2><span class="sub">hover the charts</span></div>
        <canvas class="track" id="tmap"></canvas></div>
      <div class="card"><div class="title"><h2>At cursor</h2><span class="sub" id="cur-d"></span></div>
        <div class="readout" id="readout"></div></div>
      <div class="card note" style="font-size:12.5px">Delta is time behind <b>${ref}</b> at each point of the
        lap: rising means losing time there, falling means gaining. Telemetry is sampled a few times a
        second, so short spikes (gear changes, brake taps) can be smoothed over.
        ${hasDRS ? "DRS shows when the rear-wing flap was open." : "The timing data for this session has no DRS or active-aero channel, so that panel is left out."}</div>
    </div></div>`));

  el.querySelectorAll("[data-lap]").forEach((s) => (s.onchange = () => {
    chosen[s.dataset.lap] = s.value === "fastest" ? "fastest" : +s.value;
    ctx.select(ctx.selected);
  }));

  const x = data.distance;
  const tmap = drawTrack(el.querySelector("#tmap"), { x: data.x, y: data.y, rotation: data.rotation,
    corners: data.corners, color: C.bg3, width: 4 });
  const readout = el.querySelector("#readout");
  const curD = el.querySelector("#cur-d");
  const showCursor = (idx) => {
    if (idx == null || idx < 0) return;
    tmap.redraw(series.map((s, k) => ({ i: idx, color: ctx.color(s.abbr), r: 6 - k * 0.6 })));
    curD.textContent = `${Math.round(x[idx])} m`;
    readout.innerHTML = `<span class="h"></span><span class="h">km/h</span><span class="h">Thr</span><span class="h">Brk</span>
      <span class="h">Gear</span><span class="h">RPM</span><span class="h">DRS</span><span class="h">Delta</span>` +
      series.map((s) => `<b style="color:${ctx.color(s.abbr)}">${s.abbr}</b>
        <span>${s.Speed[idx]?.toFixed(0) ?? "—"}</span><span>${s.Throttle[idx]?.toFixed(0) ?? "—"}</span>
        <span>${s.Brake[idx] ? "●" : "·"}</span><span>${s.nGear[idx] ?? "—"}</span>
        <span>${s.RPM[idx] != null ? Math.round(s.RPM[idx]) : "—"}</span><span>${s.DRS[idx] == null ? "—" : s.DRS[idx] ? "open" : ""}</span>
        <span>${s.abbr === ref ? "" : (s.delta[idx] >= 0 ? "+" : "") + (s.delta[idx] ?? 0).toFixed(3)}</span>`).join("");
  };

  // corner markers on the speed trace
  const corners = (data.corners || []).filter((c) => c.distance <= x[x.length - 1]);
  const cornerMarks = (u) => {
    const c2 = u.ctx;
    c2.save();
    c2.font = '600 10px "CaskaydiaCove Nerd Font", "Cascadia Code", monospace';
    c2.fillStyle = C.bg4; c2.strokeStyle = C.bg1; c2.textAlign = "center";
    const dpr = devicePixelRatio || 1;
    for (const c of corners) {
      const px = u.valToPos(c.distance, "x", true);
      if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue;
      c2.beginPath(); c2.moveTo(px, u.bbox.top); c2.lineTo(px, u.bbox.top + u.bbox.height); c2.stroke();
      c2.fillText(String(c.number) + (c.letter || ""), px, u.bbox.top + 10 * dpr);
    }
    c2.restore();
  };

  const host = el.querySelector("#panels");
  let syncing = false;
  // DRS only exists up to 2025, and the timing feed carries no active-aero data
  // from 2026, so the panel is left out when no lap here ever opens it
  const panels = PANELS.filter((p) => p.key !== "DRS" || hasDRS);
  for (const p of panels) {
    const div = h(`<div class="chart"><span class="ylabel">${p.label}</span><div></div></div>`);
    host.append(div);
    const target = div.lastElementChild;
    const ys = series.map((s) => ({
      label: s.abbr, values: p.delta ? s.delta : s[p.key], color: ctx.color(s.abbr),
      dash: ctx.dash(s.abbr), width: p.key === "Speed" ? 1.8 : 1.4,
    }));
    if (p.delta) ys[0] = { ...ys[0], color: C.bg3, dash: false, width: 1 };
    const u = lineChart(target, {
      x, series: ys, height: p.height, padTop: 18, sync: "tel", stepped: p.stepped, yRange: p.range,
      ySplits: p.splits, zoom: true, hideX: p !== panels[panels.length - 1],
      xFmt: (v) => `${(v / 1000).toFixed(1)} km`,
      yFmt: p.key === "Brake" ? (v) => (v ? "on" : "off") : p.key === "DRS" ? (v) => (v ? "open" : "shut")
        : p.delta ? (v) => v.toFixed(2) : undefined,
      onCursor: p.key === "Speed" ? showCursor : undefined,
      drawBands: p.key === "Speed" ? cornerMarks : undefined,
    });
    u.over.addEventListener("dblclick", () => charts.forEach((c) => c.setScale("x", { min: x[0], max: x[x.length - 1] })));
    u.hooks.setScale = [(uu, key) => {
      if (key !== "x" || syncing) return;
      syncing = true;
      const { min, max } = uu.scales.x;
      charts.forEach((c) => c !== uu && c.setScale("x", { min, max }));
      syncing = false;
    }];
    charts.push(u);
  }
  showCursor(0);
  return () => destroyCharts(charts);
}
