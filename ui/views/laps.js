// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import * as api from "../lib/api.js";
import { bandPainter, destroyCharts, lineChart } from "../lib/charts.js";
import { C, esc, fixed, h, lapTime, tyre } from "../lib/format.js";

let focus = null;
let hideSlow = true;

// teammates share a colour; the second driver's racing laps get a faded fill
const fade = (c) => (c.startsWith("rgb(") ? c.replace("rgb(", "rgba(").replace(")", ",.35)") : c);

export async function render(el, ctx) {
  const { laps } = await api.sessionData(ctx.key, "laps");
  const charts = [];
  const sel = ctx.selected.filter((a) => laps[a]);
  if (!sel.length) {
    el.append(h(`<div class="card note">Select drivers on the left to compare their laps.</div>`));
    return;
  }
  if (!sel.includes(focus)) focus = sel[0];

  // overall bests across the whole field, for purple highlighting
  const all = Object.values(laps).flat().filter((l) => !l.deleted);
  const best = {};
  for (const k of ["t", "s1", "s2", "s3", "st"]) {
    const v = all.map((l) => l[k]).filter((x) => x != null);
    best[k] = k === "st" ? Math.max(...v) : Math.min(...v);
  }
  const maxLap = Math.max(...sel.map((a) => laps[a].length ? laps[a].at(-1).n : 0));
  const x = Array.from({ length: maxLap }, (_, i) => i + 1);
  const fastestSel = Math.min(...sel.flatMap((a) => laps[a].filter((l) => !l.deleted).map((l) => l.t).filter((t) => t != null)));
  // racing laps are filled dots; everything else is still drawn, hollow, so every lap with a time shows
  const unusual = (l) => l.n === 1 || l.pit_in || l.pit_out || /[4567]/.test(l.status);
  const cap = fastestSel * 1.07;
  const slowest = Math.max(...sel.flatMap((a) => laps[a].map((l) => l.t).filter((t) => t != null)));
  const top = hideSlow ? Math.min(cap, slowest) : slowest;
  const plotted = (l) => (l.t == null ? null : Math.min(l.t, top));  // slower laps pinned to the top edge
  const series = [];
  for (const a of sel) {
    const color = ctx.color(a);
    const by = (keep) => { const m = Object.fromEntries(laps[a].filter(keep).map((l) => [l.n, plotted(l)])); return x.map((n) => m[n] ?? null); };
    series.push({ label: a, values: by((l) => !l.deleted && !unusual(l)), color, points: true, pointSize: 6,
      pointFill: ctx.dash(a) ? fade(color) : color });
    series.push({ label: a + " other", values: by((l) => !l.deleted && unusual(l)), color, points: true, pointSize: 7,
      pointFill: C.bg0s });
    series.push({ label: a + " deleted", values: by((l) => l.deleted), color: C.red, points: true, pointSize: 7,
      pointFill: C.bg0s });
  }
  const lo = fastestSel - 0.4;
  // safety car / VSC laps from the first driver's track status
  const ref = laps[sel[0]];
  const sc = ref.filter((l) => /[4567]/.test(l.status)).map((l) => [l.n - 0.5, l.n + 0.5]);

  // per-driver bests
  const rows = sel.map((a) => {
    const L = laps[a].filter((l) => !l.deleted);
    const mn = (k) => { const v = L.map((l) => l[k]).filter((x) => x != null); return v.length ? Math.min(...v) : null; };
    const mx = (k) => { const v = L.map((l) => l[k]).filter((x) => x != null); return v.length ? Math.max(...v) : null; };
    const s = [mn("s1"), mn("s2"), mn("s3")];
    const ideal = s.every((v) => v != null) ? s[0] + s[1] + s[2] : null;
    return { a, best: mn("t"), s, ideal, st: mx("st"), i1: mx("i1"), i2: mx("i2"), fl: mx("fl"), n: L.filter((l) => l.t != null).length };
  });
  const cls = (v, k) => (v != null && v === best[k] ? "ob" : "");

  el.append(h(`<div class="grid">
    <div class="card"><div class="title"><h2>Lap times</h2><span class="sub">every lap with a time · filled = racing lap</span>
      <div class="tools"><button class="chip ${hideSlow ? "on" : ""}" id="slow" title="Laps slower than 107% of the fastest are drawn on the top edge">Zoom to racing pace</button></div></div>
      <div class="legend">${sel.map((a) => `<span><i class="${ctx.dash(a) ? "dash" : ""}" style="background:${ctx.color(a)};color:${ctx.color(a)}"></i>${a}</span>`).join("")}
      ${sel.some((a) => ctx.dash(a)) ? `<span class="muted">faded fill = second driver of a team</span>` : ""}
      <span class="muted">○ lap 1, pit in / out, SC / VSC</span><span style="color:${C.red}">○ deleted</span>
      ${hideSlow ? `<span class="muted">dots on the top edge are slower than shown</span>` : ""}
      ${sc.length ? `<span><i style="background:${C.yellow};opacity:.35;height:10px"></i>Safety car / VSC</span>` : ""}</div>
      <div id="lapchart"></div><div class="muted" id="lapread" style="min-height:20px;margin-top:6px;font-size:12px">Hover the chart for lap details.</div></div>
    <div class="card"><div class="title"><h2>Bests</h2><span class="sub">purple = fastest in the session</span></div>
      <table class="t"><thead><tr><th>Driver</th><th class="num">Best lap</th><th class="num">S1</th><th class="num">S2</th>
      <th class="num">S3</th><th class="num">Ideal lap</th><th class="num">Lost</th><th class="num">Trap 1</th><th class="num">Trap 2</th>
      <th class="num">Finish line</th><th class="num">Speed trap</th><th class="num">Laps</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><div class="teamcell"><i style="background:${ctx.color(r.a)}"></i><b>${r.a}</b></div></td>
        <td class="num ${cls(r.best, "t")}">${lapTime(r.best)}</td>
        ${r.s.map((v, k) => `<td class="num ${cls(v, "s" + (k + 1))}">${v != null ? v.toFixed(3) : "—"}</td>`).join("")}
        <td class="num">${lapTime(r.ideal)}</td>
        <td class="num muted">${r.ideal != null && r.best != null ? Math.max(0, r.best - r.ideal).toFixed(3) : "—"}</td>
        <td class="num">${fixed(r.i1)}</td><td class="num">${fixed(r.i2)}</td><td class="num">${fixed(r.fl)}</td>
        <td class="num ${cls(r.st, "st")}">${fixed(r.st)}</td><td class="num muted">${r.n}</td></tr>`).join("")}
      </tbody></table></div>
    <div class="card"><div class="title"><h2>Every lap</h2>
      <div class="tools">${sel.map((a) => `<button class="chip ${a === focus ? "on" : ""}" data-f="${a}">${a}</button>`).join("")}</div></div>
      <div class="scroll-y" id="laptable"></div></div>
  </div>`));

  const read = el.querySelector("#lapread");
  function showLap(i) {
    if (i == null) return;
    const n = x[i];
    read.innerHTML = `<b style="color:var(--fg2)">L${n}</b> &nbsp;` + sel.map((a) => {
      const l = laps[a].find((q) => q.n === n);
      if (!l) return `<span style="color:${ctx.color(a)}">${a}</span> —`;
      const notes = [l.n === 1 && "lap 1", l.pit_in && "in-lap", l.pit_out && "out-lap", /4/.test(l.status) && "SC",
        /[67]/.test(l.status) && "VSC", /5/.test(l.status) && "red flag", l.deleted && "deleted"].filter(Boolean);
      return `<span style="color:${ctx.color(a)}">${a}</span> ${lapTime(l.t)}${l.compound ? ` · ${l.compound.toLowerCase()} ${l.life ?? ""}` : ""}${notes.length ? ` · ${notes.join(", ")}` : ""}`;
    }).join(" &nbsp;&nbsp; ");
  }
  charts.push(lineChart(el.querySelector("#lapchart"), {
    x, series, height: 300, yFmt: (v) => lapTime(v), ySize: 76, xFmt: (v) => (Number.isInteger(v) ? `L${v}` : ""),
    yRange: [lo, top + 0.3], onCursor: showLap,
    drawBands: sc.length ? bandPainter(sc, "rgba(250,189,47,.10)") : undefined,
  }));
  el.querySelector("#slow").onclick = () => { hideSlow = !hideSlow; ctx.select(ctx.selected); };
  el.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { focus = b.dataset.f; ctx.select(ctx.selected); }));

  const L = laps[focus];
  const pb = Math.min(...L.filter((l) => !l.deleted && l.t != null).map((l) => l.t));
  el.querySelector("#laptable").innerHTML = `<table class="t"><thead><tr><th class="num">Lap</th><th class="num">Time</th>
    <th class="num">S1</th><th class="num">S2</th><th class="num">S3</th><th>Tyre</th><th class="num">Age</th>
    <th class="num">Trap 1</th><th class="num">Trap 2</th><th class="num">Finish</th><th class="num">Trap</th>
    <th class="num">Pos</th><th>Notes</th></tr></thead><tbody>${L.map((l) => {
      const tcls = l.deleted ? "del" : l.t === best.t ? "ob" : l.t === pb ? "pb" : "";
      const notes = [l.pit_in && "In", l.pit_out && "Out", /4/.test(l.status) && "SC", /[67]/.test(l.status) && "VSC",
        /5/.test(l.status) && "Red", l.deleted && "Deleted"].filter(Boolean).join(" · ");
      return `<tr><td class="num muted">${l.n}</td><td class="num ${tcls}">${lapTime(l.t)}</td>
        ${["s1", "s2", "s3"].map((k) => `<td class="num ${l[k] === best[k] ? "ob" : ""}">${l[k] != null ? l[k].toFixed(3) : ""}</td>`).join("")}
        <td>${l.compound ? tyre(l.compound) : ""}</td><td class="num muted">${l.life ?? ""}</td>
        <td class="num">${fixed(l.i1)}</td><td class="num">${fixed(l.i2)}</td><td class="num">${fixed(l.fl)}</td>
        <td class="num">${fixed(l.st)}</td><td class="num muted">${l.pos ?? ""}</td><td class="muted">${notes}</td></tr>`;
    }).join("")}</tbody></table>`;
  return () => destroyCharts(charts);
}
