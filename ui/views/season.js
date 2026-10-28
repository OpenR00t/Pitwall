// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import * as api from "../lib/api.js";
import { destroyCharts, lineChart } from "../lib/charts.js";
import { C, esc, h, readable } from "../lib/format.js";
import { guide } from "../lib/guide.js";
import { bands, findingsCard, rank, rankCell } from "../lib/findings.js";

const results = {}; // year -> rounds

// team colours from whichever session is loaded; others get a gruvbox colour
const FALLBACK = [C.green, C.aqua, C.blue, C.purple, C.orange, C.yellow, C.red, C.fg3, "#689d6a", "#458588", "#b16286"];

// each team's level, direction and consistency over the season
function findings(rounds, teams, colorOf) {
  const half = Math.ceil(rounds.length / 2);
  const vals = (t, rs) => rs.map((r) => r.teams[t]).filter((x) => x != null);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const st = {};
  for (const t of teams) {
    const all = vals(t, rounds), m = mean(all);
    const early = mean(vals(t, rounds.slice(0, half))), late = mean(vals(t, rounds.slice(half)));
    st[t] = { avg: m, trend: early != null && late != null ? early - late : null,
      spread: all.length > 1 ? Math.sqrt(mean(all.map((x) => (x - m) ** 2))) : null };
  }
  const lvl = rank(Object.fromEntries(teams.map((t) => [t, st[t].avg])), { lowerBetter: true });
  const dir = rank(Object.fromEntries(teams.map((t) => [t, st[t].trend])));
  const con = rank(Object.fromEntries(teams.map((t) => [t, st[t].spread])), { lowerBetter: true });
  const n = teams.length;
  const b = bands(n);
  const rows = teams.map((t, i) => {
    const s = st[t];
    let tag = "steady", text = "about the same pace all year";
    if (s.trend != null && s.trend >= 0.25) [tag, text] = ["gaining", `${s.trend.toFixed(2)} percentage points closer to pole in the second half than the first`];
    else if (s.trend != null && s.trend <= -0.25) [tag, text] = ["fading", `${(-s.trend).toFixed(2)} percentage points further off pole in the second half than the first`];
    if (lvl[t] === 1) text = "the benchmark car; " + text;
    if (b.bottom(con[t]) && s.spread >= 0.3) text += "; pace swings a lot from track to track";
    else if (b.top(con[t])) text += "; consistent from track to track";
    return { team: t, color: colorOf(t, i), tag, text,
      cells: [rankCell(lvl[t], n, s.avg.toFixed(2) + "%"),
        rankCell(dir[t], n, s.trend == null ? "" : (s.trend >= 0 ? "+" : "") + s.trend.toFixed(2)),
        rankCell(con[t], n, s.spread == null ? "" : "±" + s.spread.toFixed(2))] };
  });
  return findingsCard({
    sub: "average gap to pole · change from first half to second half · how much it varies",
    columns: ["Level", "Direction", "Consistency"],
    rows,
    note: "Direction compares the average gap in the first half of the rounds with the second half (positive = closer to pole). Track layouts favour different cars, so one round on its own says little.",
  });
}

export async function render(el, ctx) {
  const year = ctx.year;
  const charts = [];
  if (year == null) { el.append(h(`<div class="card note">Pick a season on the left.</div>`)); return; }
  const card = h(`<div class="grid">
    ${guide("season", {
      question: "how has each team's raw pace changed over the year?",
      steps: [
        ["The numbers", "Each team's best qualifying lap at every round, as a percentage behind the fastest team that weekend. 0% (<b>pole</b>) is the quickest car. Percentages let tracks of different lengths be compared."],
        ["The chart", "One line per team, quickest at the top. A line moving up through the year means the team is gaining on the front; moving down means it is falling back, often after rivals bring upgrades."],
        ["Why qualifying", "Low fuel and new tyres for everyone, so it is the cleanest measure of how fast the car is."],
      ],
      exampleLabel: "This season",
      example: `<span id="sex">Build the season to see a reading of it here.</span>`,
    })}
    <div id="sfind" style="display:contents"></div>
    <div class="card"><div class="title"><h2>${year === ctx.demoYear ? "Demo" : year} qualifying pace</h2>
      <span class="sub">each team's best qualifying lap, % off the fastest team, round by round</span>
      <div class="tools"><button class="btn primary small" id="go">${results[year] ? "Refresh" : "Build"}</button></div></div>
      <div id="sbody" class="note">Loads the qualifying timing of every finished round (no telemetry),
      so the first build takes a few minutes. Finished rounds are kept, so later builds only fetch new ones.</div></div>
  </div>`);
  el.append(card);
  const body = card.querySelector("#sbody");

  const draw = (rounds) => {
    if (!rounds.length) { body.textContent = "No finished rounds yet."; return; }
    const teams = [...new Set(rounds.flatMap((r) => Object.keys(r.teams)))];
    const colorOf = (t, i) => {
      const d = ctx.ov && ctx.ov.drivers.find((x) => x.team === t);
      return d ? readable(d.color) : FALLBACK[i % FALLBACK.length];
    };
    const avg = (t) => { const v = rounds.map((r) => r.teams[t]).filter((x) => x != null); return v.reduce((a, b) => a + b, 0) / v.length; };
    teams.sort((a, b) => avg(a) - avg(b));
    const ex = card.querySelector("#sex");
    if (ex && rounds.length >= 2) {
      const half = Math.ceil(rounds.length / 2);
      const mean = (t, rs) => { const v = rs.map((r) => r.teams[t]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const trend = teams.map((t) => [t, mean(t, rounds.slice(0, half)), mean(t, rounds.slice(half))])
        .filter(([, a, b]) => a != null && b != null).map(([t, a, b]) => [t, a - b]);
      trend.sort((a, b) => b[1] - a[1]);
      const up = trend[0], down = trend.at(-1);
      ex.innerHTML = `<b>${esc(teams[0])}</b> has been quickest on average (${avg(teams[0]).toFixed(2)}% off pole).
        Most improved from the first half to the second: <b>${esc(up[0])}</b> (${up[1].toFixed(2)} percentage points closer).` +
        (down[1] < -0.05 ? ` Falling back most: <b>${esc(down[0])}</b> (${(-down[1]).toFixed(2)} percentage points further off).` : "");
    }
    const sf = card.querySelector("#sfind");
    if (sf && rounds.length >= 2) sf.innerHTML = findings(rounds, teams, colorOf);
    body.className = "";
    body.innerHTML = `<div class="legend">${teams.map((t, i) => `<span><i style="background:${colorOf(t, i)}"></i>${esc(t)}
      <span class="muted">${avg(t).toFixed(2)}%</span></span>`).join("")}</div><div id="schart"></div>
      <div style="overflow-x:auto;margin-top:12px"><table class="t"><thead><tr><th>Team</th>
      ${rounds.map((r) => `<th class="num" title="${esc(r.event)}">R${r.round}</th>`).join("")}<th class="num">Avg</th></tr></thead><tbody>
      ${teams.map((t, i) => `<tr><td><div class="teamcell"><i style="background:${colorOf(t, i)}"></i>${esc(t)}</div></td>
        ${rounds.map((r) => { const v = r.teams[t]; return `<td class="num ${v === 0 ? "ob" : ""}">${v == null ? "—" : v === 0 ? "pole" : v.toFixed(2)}</td>`; }).join("")}
        <td class="num">${avg(t).toFixed(2)}</td></tr>`).join("")}</tbody></table></div>`;
    charts.push(lineChart(body.querySelector("#schart"), {
      x: rounds.map((r) => r.round), height: 340, yDir: -1, xFmt: (v) => (Number.isInteger(v) ? `R${v}` : ""),
      yFmt: (v) => `${v.toFixed(1)}%`,
      series: teams.map((t, i) => ({ label: t, values: rounds.map((r) => r.teams[t] ?? null), color: colorOf(t, i),
        width: 2, spanGaps: true })),
    }));
  };

  const go = card.querySelector("#go");
  go.onclick = async () => {
    go.disabled = true;
    body.className = "loading";
    body.innerHTML = `<div class="row"><div class="spinner"></div><span>Building…</span></div><pre class="progress-log"></pre>`;
    try {
      const r = await api.runJob("season", { year }, (p) => {
        const log = body.querySelector(".progress-log");
        if (log) log.textContent = p.slice(-6).join("\n");
      });
      results[year] = r.rounds;
      body.className = "";
      destroyCharts(charts);
      draw(r.rounds);
      go.textContent = "Refresh";
    } catch (e) {
      body.className = "note error";
      body.textContent = e.message;
      if (e.auth) ctx.onAuthNeeded();
    }
    go.disabled = false;
  };
  if (results[year]) draw(results[year]);
  return () => destroyCharts(charts);
}
