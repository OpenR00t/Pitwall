// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import * as api from "../lib/api.js";
import { destroyCharts, lineChart } from "../lib/charts.js";
import { esc, h, lapTime, tyre } from "../lib/format.js";
import { guide } from "../lib/guide.js";
import { bands, findingsCard, rank, rankCell, conditionsNote } from "../lib/findings.js";

// fuel figure the user typed, for the session it was typed in; otherwise the
// backend works one out from the season's fuel allowance and the race length
let fuel = null, fuelKey = null;
let sortKey = "deg";

function longrunsExample(stints, tl) {
  if (!tl.length) return "";
  const long = stints.filter((s) => s.laps >= 8 && s.compound !== "UNKNOWN");
  const pool = long.length >= 2 ? long : stints;
  const gentle = [...pool].sort((a, b) => a.deg - b.deg)[0];
  const harsh = [...pool].sort((a, b) => b.deg - a.deg)[0];
  let out = `<b>${esc(tl[0][0])}</b> has the best race pace${tl[0][1].lateShare >= 0.4 ? ", helped by a late stint on fresh tyres" : ""}.`;
  if (tl.length > 1) out += ` <b>${esc(tl[1][0])}</b> is next, ${(tl[1][1].v - tl[0][1].v).toFixed(3)} s a lap behind.`;
  out += ` Kindest on tyres: <b>${gentle.abbr}</b> on ${gentle.compound.toLowerCase()}s (+${Math.max(0, gentle.deg).toFixed(3)} s/lap over ${gentle.laps} laps).
    Hardest: <b>${harsh.abbr}</b> on ${harsh.compound.toLowerCase()}s (+${harsh.deg.toFixed(3)} s/lap).`;
  return out;
}

// race pace, tyre wear and one-lap pace per team, and what they say together
async function findings(ctx, stints, tl) {
  const pace = rank(Object.fromEntries(tl.map(([t, { v }]) => [t, v])), { lowerBetter: true });
  const byTeam = {};
  for (const s of stints) (byTeam[s.team] ||= []).push(s);
  // wear is compared with the typical wear on the same compound this session,
  // since softs wear faster than hards and track conditions move all of them
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
  const usable = stints.filter((s) => s.laps >= 8);
  const typical = {};
  for (const c of new Set(usable.map((s) => s.compound))) {
    const v = usable.filter((s) => s.compound === c).map((s) => s.deg);
    typical[c] = v.length >= 3 ? median(v) : median(usable.map((s) => s.deg));
  }
  const degOf = {};
  for (const [t, list] of Object.entries(byTeam)) {
    const long = list.filter((s) => s.laps >= 8);
    const use = long.length ? long : list;
    const laps = use.reduce((a, s) => a + s.laps, 0);
    degOf[t] = use.reduce((a, s) => a + (s.deg - (typical[s.compound] ?? median(usable.map((x) => x.deg)))) * s.laps, 0) / laps;
  }
  const deg = rank(degOf, { lowerBetter: true });
  // one-lap pace: each team's best valid lap of the session
  let one = {};
  try {
    const { laps } = await api.sessionData(ctx.key, "laps");
    const teamOf = Object.fromEntries(ctx.ov.drivers.map((d) => [d.abbr, d.team]));
    const best = {};
    for (const [a, L] of Object.entries(laps)) {
      for (const l of L) {
        if (l.t == null || l.deleted) continue;
        const t = teamOf[a];
        if (best[t] == null || l.t < best[t]) best[t] = l.t;
      }
    }
    one = rank(Object.fromEntries(Object.entries(best).filter(([t]) => pace[t] != null)), { lowerBetter: true });
  } catch { /* no lap data: leave one-lap pace out */ }
  const teams = Object.keys(pace).sort((a, b) => pace[a] - pace[b]);
  const n = teams.length;
  const winner = ctx.ov.meta.type === "R" || ctx.ov.meta.type === "S"
    ? ctx.ov.drivers.find((x) => x.abbr === (ctx.ov.order || [])[0]) : null;
  const b = bands(n);
  const rows = teams.map((t) => {
    const p = pace[t], g = deg[t], o = one[t];
    let tag = "middle of the pack", text = "average pace and tyre wear";
    if (b.top(p) && b.top(g)) [tag, text] = ["strong race car", "quick over a stint and easy on its tyres"];
    else if (b.top(p) && b.bottom(g)) [tag, text] = ["fast but hard on tyres", "quick early in a stint, but the tyres fade"];
    else if (b.bottom(p) && b.top(g)) [tag, text] = ["kind to tyres", "not quick, but its tyres last: could stretch a stint or stop less"];
    else if (b.bottom(p) && b.bottom(g)) [tag, text] = ["struggling", "slow over a stint and hard on its tyres"];
    else if (b.top(p)) [tag, text] = ["good race pace", "among the quickest over a stint"];
    else if (b.bottom(p)) [tag, text] = ["slow over a stint", "among the slowest over a long run"];
    const who = tl.find(([x]) => x === t)[1];
    if (winner && winner.team === t && p > 1) text += `; won the race, and a leader with a gap manages pace and tyres, so this understates the car`;
    if (who.lateShare >= 0.4 && b.top(p)) {
      tag = "pace flattered by strategy";
      text = `much of its pace comes from a late stint on fresh tyres while others ran old ones, so the ranking says as much about strategy as about the car`;
    }
    if (who.traffic >= 0.5) text += `; spent ${Math.round(who.traffic * 100)}% of these laps within 1.5 s of the car ahead, so traffic held it back`;
    if (o != null && o - p >= b.third) text += "; much better over a stint than over one lap";
    else if (o != null && p - o >= b.third) text += "; quicker over one lap than over a stint";
    const gap = tl[0] ? tl.find(([x]) => x === t)[1].v - tl[0][1].v : 0;
    return { team: t, color: ctx.teamColor(t), tag, text,
      cells: [rankCell(p, n, gap > 0 ? "+" + gap.toFixed(3) : ""), rankCell(g, n, `${degOf[t] >= 0 ? "+" : ""}${degOf[t].toFixed(3)}`),
        ...(Object.keys(one).length ? [rankCell(o, n)] : [])] };
  });
  return findingsCard({
    sub: "race pace (clean laps, fuel-corrected, quicker driver) · tyre wear (s/lap against the typical wear on the same compound) · one-lap pace",
    columns: ["Race pace", "Tyre wear", ...(Object.keys(one).length ? ["One lap"] : [])],
    rows,
    note: (() => {
      const all = [...new Set(ctx.ov.drivers.map((x) => x.team))];
      const none = all.filter((t) => pace[t] == null);
      return none.length ? `No run of five or more clean laps from ${none.map(esc).join(", ")}, so ${none.length > 1 ? "they're" : "it's"} not ranked. ` : "";
    })() + (winner ? "In a race, pace also reflects strategy: when each car stopped, how old its tyres were, whether it was held up, and how hard the front-runners pushed. " : "") + "Teams run different compounds and fuel loads, especially in practice, so treat gaps of a few tenths as rough. Comparing race pace with one-lap pace shows whether a car is built for qualifying or for Sundays.",
  });
}

export async function render(el, ctx) {
  if (fuelKey !== ctx.key) { fuel = null; fuelKey = ctx.key; }
  const d = await api.sessionData(ctx.key, "longruns", fuel == null ? "" : `fuel=${fuel}`);
  const charts = [];
  if (!d.available) {
    el.append(h(`<div class="card note">No clean stints of five laps or more in this session.</div>`));
    return;
  }
  const sel = ctx.selected.length ? ctx.selected : [];
  const shown = d.stints.filter((s) => !sel.length || sel.includes(s.abbr));
  const maxLife = Math.max(...shown.flatMap((s) => s.points.map((p) => p.life ?? 0)), 1);
  const x = Array.from({ length: maxLife }, (_, i) => i + 1);

  // team race pace: each driver's clean stints averaged by laps (so one short,
  // fast stint can't stand for a whole race), then the team's quicker driver
  const perDriver = {};
  for (const s of d.stints) {
    const p = (perDriver[s.abbr] ||= { team: s.team, sum: 0, laps: 0, late: 0, traffic: 0, s });
    p.sum += s.median_corrected * s.laps;
    p.laps += s.laps;
    // a stint begun late in the race on nearly new tyres, against cars on old ones
    if (s.start_share != null && s.start_share >= 0.6 && s.tyre_start != null && s.tyre_start <= 5) p.late += s.laps;
    p.traffic += (s.traffic || 0) * s.laps;
  }
  const team = {};
  for (const [abbr, p] of Object.entries(perDriver)) {
    const v = p.sum / p.laps;
    if (!team[p.team] || v < team[p.team].v) {
      team[p.team] = { v, s: p.s, abbr, laps: p.laps, lateShare: p.late / p.laps, traffic: p.traffic / p.laps };
    }
  }
  const tl = Object.entries(team).sort((a, b) => a[1].v - b[1].v);
  const best = tl.length ? tl[0][1].v : 0;
  const worst = tl.length ? tl.at(-1)[1].v : 1;

  const found = await findings(ctx, d.stints, tl);
  const sorted = [...d.stints].sort((a, b) => (sortKey === "deg" ? a.deg - b.deg : a.median_corrected - b.median_corrected));
  el.append(h(`<div class="grid">
    ${guide("longruns", {
      question: "who has the best race pace, and whose tyres last?",
      steps: [
        ["Which laps", "Stints of five or more clean laps: no pit stops, safety car or deleted laps, and within 107% of the driver's best."],
        ["Fuel correction", `Cars get lighter (and faster) as fuel burns, which hides tyre wear. ${d.fuel_basis === "race"
          ? `In a race every lap is brought to an empty tank, so stints from early and late in the race compare fairly.`
          : `Fuel loads in practice aren't known, so each lap gets a little time added per lap into the stint to cancel the fuel burned within it.`}
          The <b>fuel</b> box on the chart starts at ${d.fuel_default.toFixed(3)} s per lap: a full race's fuel
          (${(ctx.ov.meta.year ?? 2026) >= 2026 ? "about 70 kg under the 2026 rules" : "about 100 kg"}) spread over the race's laps, at roughly 0.035 s per kg.
          It's an estimate; change it to see how much the wear figures depend on it.`],
        ["The chart", "Corrected lap time against how old the tyre is. A flat line means the tyre is holding up; a line climbing to the right is <b>degradation</b>. Lower lines are faster."],
        ["Race pace by team", "Each driver's clean stints averaged by how many laps they ran, fuel-corrected; the team's quicker driver counts. Different tyre compounds aren't directly comparable, so check the table for like-for-like runs."],
        ["Strategy", "A driver with a comfortable lead turns the pace down and saves the tyres; a car stuck behind another can't show its pace; a late stop for fresh tyres makes a car look quick against cars on old ones. The findings flag each of these."],
        ["Degradation", "Seconds per lap lost to tyre wear across the stint. Under about 0.03 s/lap is very gentle, over 0.08 is heavy."],
      ],
      example: longrunsExample(d.stints, tl),
    })}
    ${conditionsNote(ctx)}
    ${found}
    <div class="grid g-main">
      <div class="card"><div class="title"><h2>Stints</h2><span class="sub">fuel-corrected lap time by tyre age ·
        ${sel.length ? "selected drivers" : "all drivers"}</span>
        <div class="tools muted" style="font-size:12px">fuel <input type="number" id="fuel" step="0.005" min="0" max="0.2" value="${d.fuel}" style="width:76px"> s/lap</div></div>
        <div class="legend">${shown.map((s) => `<span><i class="${ctx.dash(s.abbr) ? "dash" : ""}" style="background:${ctx.color(s.abbr)};color:${ctx.color(s.abbr)}"></i>${s.abbr} ${tyre(s.compound)}</span>`).join("")}</div>
        <div id="lrchart"></div></div>
      <div class="card"><div class="title"><h2>Race pace by team</h2><span class="sub">clean laps, quicker driver</span></div>
        <div class="bars">${tl.map(([t, { v, s }]) => `<div class="bar-row" style="grid-template-columns:120px 1fr 64px">
          <span class="name">${esc(t)}</span><span class="track"><span class="fill" style="width:${8 + ((worst - v) / (worst - best || 1)) * 92}%;background:${ctx.teamColor(t)}"></span></span>
          <span class="val">${v === best ? lapTime(v) : "+" + (v - best).toFixed(3)}</span></div>`).join("")}</div>
        <div class="note muted" style="font-size:12px;margin-top:10px">Compounds differ, so compare teams on the same tyre where you can (table below).</div></div>
    </div>
    <div class="card"><div class="title"><h2>All stints</h2>
      <div class="tools"><button class="chip ${sortKey === "deg" ? "on" : ""}" data-s="deg">Sort by degradation</button>
      <button class="chip ${sortKey === "pace" ? "on" : ""}" data-s="pace">Sort by pace</button></div></div>
      <div class="scroll-y"><table class="t"><thead><tr><th>Driver</th><th>Team</th><th>Tyre</th><th class="num">Laps</th>
      <th class="num">Clean</th><th class="num">Median</th><th class="num">Corrected</th><th class="num">Degradation</th></tr></thead><tbody>
      ${sorted.map((s) => `<tr><td><div class="teamcell"><i style="background:${ctx.color(s.abbr)}"></i><b>${s.abbr}</b></div></td>
        <td class="muted">${esc(s.team)}</td><td>${tyre(s.compound)}</td><td class="num muted">${s.from}–${s.to}</td>
        <td class="num">${s.laps}</td><td class="num">${lapTime(s.median)}</td><td class="num">${lapTime(s.median_corrected)}</td>
        <td class="num" style="color:${s.deg > 0.08 ? "var(--red)" : s.deg < 0.03 ? "var(--green)" : "var(--fg1)"}">${s.deg >= 0 ? "+" : ""}${s.deg.toFixed(3)} s/lap</td></tr>`).join("")}
      </tbody></table></div></div>
  </div>`));
  el.querySelector("#fuel").onchange = (e) => { fuel = Math.max(0, +e.target.value || 0); ctx.select(ctx.selected); };
  el.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { sortKey = b.dataset.s; ctx.select(ctx.selected); }));

  charts.push(lineChart(el.querySelector("#lrchart"), {
    x, height: 340, xFmt: (v) => (Number.isInteger(v) ? `${v}` : ""), yFmt: (v) => lapTime(v), ySize: 76,
    series: shown.map((s) => {
      const m = Object.fromEntries(s.points.map((p) => [p.life, p.c]));
      return { label: `${s.abbr} ${s.compound}`, values: x.map((n) => m[n] ?? null), color: ctx.color(s.abbr),
        dash: ctx.dash(s.abbr), points: false, width: 1.6, spanGaps: true };
    }),
  }));
  return () => destroyCharts(charts);
}
