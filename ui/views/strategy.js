// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import * as api from "../lib/api.js";
import { bandPainter, destroyCharts, lineChart } from "../lib/charts.js";
import { C, COMPOUNDS, compoundColor, esc, h } from "../lib/format.js";

export async function render(el, ctx) {
  const { laps } = await api.sessionData(ctx.key, "laps");
  const charts = [];
  const isRace = ["R", "S"].includes(ctx.ov.meta.type);
  const order = ctx.ov.order.filter((a) => laps[a] && laps[a].length);
  const total = Math.max(...order.map((a) => laps[a].at(-1).n));

  // stints from consecutive laps with the same stint number
  const stintsOf = (a) => {
    const out = [];
    for (const l of laps[a]) {
      const s = out.at(-1);
      if (s && s.stint === l.stint) { s.to = l.n; s.age = l.life; }
      else out.push({ stint: l.stint, compound: l.compound, from: l.n, to: l.n, age: l.life, fresh: (l.life ?? 1) <= 2 });
    }
    return out;
  };
  const ref = laps[order[0]];
  const sc = ref.filter((l) => /[4567]/.test(l.status)).map((l) => [l.n - 1, l.n]);
  const used = new Set(order.flatMap((a) => laps[a].map((l) => l.compound)).filter(Boolean));

  const rows = order.map((a) => {
    const st = stintsOf(a);
    return `<div class="strat-row" style="display:grid;grid-template-columns:48px 1fr;gap:10px;align-items:center;height:22px">
      <span style="font-weight:700;color:${ctx.color(a)}">${a}</span>
      <div style="position:relative;height:14px">${st.map((s) => {
        const left = ((s.from - 1) / total) * 100, width = ((s.to - s.from + 1) / total) * 100;
        const col = compoundColor(s.compound);
        return `<div title="${esc(s.compound || "?")} · laps ${s.from}–${s.to}${s.fresh ? "" : " (used set)"}"
          style="position:absolute;left:${left}%;width:calc(${width}% - 2px);top:0;bottom:0;border-radius:3px;
          background:${col};opacity:${s.fresh ? 0.9 : 0.55};
          ${s.fresh ? "" : `background-image:repeating-linear-gradient(135deg,transparent 0 4px,rgba(29,32,33,.35) 4px 7px)`}"></div>`;
      }).join("")}</div></div>`;
  }).join("");
  const scMarks = sc.map(([a]) => `<div style="position:absolute;left:${(a / total) * 100}%;width:${100 / total}%;top:0;bottom:0;background:rgba(250,189,47,.12)"></div>`).join("");
  const ticks = Array.from({ length: Math.floor(total / 5) + 1 }, (_, i) => i * 5).filter((n) => n > 0)
    .map((n) => `<span style="position:absolute;left:${((n - 0.5) / total) * 100}%;transform:translateX(-50%)">${n}</span>`).join("");

  el.append(h(`<div class="grid">
    <div class="card"><div class="title"><h2>Tyre strategy</h2>
      <span class="sub">striped = started the stint on a used set</span>
      <div class="tools legend" style="margin:0">${[...used].map((c) => `<span><i style="background:${compoundColor(c)};height:8px"></i>${esc(c[0] + c.slice(1).toLowerCase())}</span>`).join("")}
      ${sc.length ? `<span><i style="background:${C.yellow};opacity:.4;height:8px"></i>SC / VSC</span>` : ""}</div></div>
      <div style="position:relative">
        <div style="position:absolute;left:58px;right:0;top:0;bottom:0;pointer-events:none">${scMarks}</div>
        <div style="display:grid;gap:3px">${rows}</div>
        <div style="position:relative;margin-left:58px;height:16px;font-size:11px;color:${C.gray};margin-top:4px">${ticks}</div>
      </div></div>
    ${isRace ? `<div class="grid g2">
      <div class="card"><div class="title"><h2>Positions</h2><span class="sub">selected drivers, or the top 10</span></div><div id="pos"></div></div>
      <div class="card"><div class="title"><h2>Gap to leader</h2><span class="sub">seconds, end of each lap</span></div><div id="gaps"></div></div>
    </div>` : ""}
  </div>`));

  if (isRace) {
    const race = await api.sessionData(ctx.key, "race");
    const who = (ctx.selected.length >= 2 ? ctx.selected : order.slice(0, 10)).filter((a) => race.drivers[a]);
    const x = Array.from({ length: total }, (_, i) => i + 1);
    const pick = (a, k) => {
      const d = race.drivers[a];
      const m = Object.fromEntries(d.lap.map((n, i) => [n, d[k][i]]));
      return x.map((n) => m[n] ?? null);
    };
    const band = sc.length ? bandPainter(sc.map(([a, b]) => [a + 0.5, b + 0.5]), "rgba(250,189,47,.10)") : undefined;
    charts.push(lineChart(el.querySelector("#pos"), {
      x, height: 330, yDir: -1, yRange: [0.5, order.length + 0.5], ySplits: [1, 5, 10, 15, 20],
      xFmt: (v) => `L${v}`, drawBands: band,
      series: who.map((a) => ({ label: a, values: pick(a, "pos"), color: ctx.color(a), dash: ctx.dash(a), width: 2 })),
    }));
    charts.push(lineChart(el.querySelector("#gaps"), {
      x, height: 330, yDir: -1, xFmt: (v) => `L${v}`, yFmt: (v) => `${v.toFixed(0)}s`, drawBands: band,
      series: who.map((a) => ({ label: a, values: pick(a, "gap"), color: ctx.color(a), dash: ctx.dash(a), width: 2 })),
    }));
    const legend = `<div class="legend">${who.map((a) => `<span><i class="${ctx.dash(a) ? "dash" : ""}" style="background:${ctx.color(a)};color:${ctx.color(a)}"></i>${a}</span>`).join("")}</div>`;
    el.querySelectorAll("#pos, #gaps").forEach((c) => c.insertAdjacentHTML("beforebegin", legend));
  }
  return () => destroyCharts(charts);
}
