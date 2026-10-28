// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import * as api from "../lib/api.js";
import { C, esc, h } from "../lib/format.js";
import { guide } from "../lib/guide.js";
import { bands, findingsCard, rank, rankCell, conditionsNote, loneNote, sessionBanner, lapNote } from "../lib/findings.js";

function enginesExample(fams) {
  const multi = fams.filter((f) => f.teams.filter((t) => t.gap_pct != null && t.top != null).length >= 2);
  if (!multi.length) return "";
  const spread = (f) => { const g = f.teams.map((t) => t.gap_pct).filter((x) => x != null); return Math.max(...g) - Math.min(...g); };
  const f = [...multi].sort((a, b) => spread(b) - spread(a))[0];
  const ts = f.teams.filter((t) => t.gap_pct != null && t.top != null).sort((a, b) => a.gap_pct - b.gap_pct);
  const ref = ts.find((t) => t.works) || ts[0];
  const rest = ts.filter((t) => t !== ref);
  // prefer a team with the same straight-line speed but a slower lap: that shows the chassis gap
  const close = rest.filter((t) => Math.abs(ref.top - t.top) < 5);
  const other = (close.length ? close : rest).at(-1);
  const dTop = ref.top - other.top, dLap = other.gap_pct - ref.gap_pct;
  const role = ref.works ? "works team" : "quickest";
  let out = `<b>${esc(ref.team)}</b> (${role}) and <b>${esc(other.team)}</b> both use ${esc(f.maker)} engines.
    ${esc(ref.team)} is ${dLap.toFixed(2)}% quicker over a lap, `;
  out += Math.abs(dTop) < 5
    ? `yet their top speeds are within ${Math.abs(dTop).toFixed(1)} km/h, so most of that gap is the <b>chassis</b>, not the engine.`
    : `and ${dTop > 0 ? "also" : "yet"} ${dTop > 0 ? `${dTop.toFixed(1)} km/h faster` : `${(-dTop).toFixed(1)} km/h slower`} at top speed.
       With the same engine, that points to drag and aero choices rather than power.`;
  return out;
}

// what each engine maker's group of teams says about the engine itself
function findings(ctx, fams, d) {
  const clipOk = d.clipping_relevant !== false && (d.clipping_repeat == null || d.clipping_repeat >= 0.6);
  const stat = {};
  for (const f of fams) {
    const ts = f.teams;
    const vals = (k) => ts.map((t) => t[k]).filter((x) => x != null);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const gaps = vals("gap_pct"), tops = vals("top");
    stat[f.maker] = {
      top: mean(tops), clip: mean(vals("flat_longest")), best: gaps.length ? Math.min(...gaps) : null,
      spread: gaps.length > 1 ? Math.max(...gaps) - Math.min(...gaps) : null,
      topSpread: tops.length > 1 ? Math.max(...tops) - Math.min(...tops) : null,
      n: ts.length, color: ctx.teamColor((ts.find((t) => t.works) || ts[0]).team),
    };
  }
  const makers = Object.keys(stat);
  const top = rank(Object.fromEntries(makers.map((m) => [m, stat[m].top])));
  const clip = clipOk ? rank(Object.fromEntries(makers.map((m) => [m, stat[m].clip])), { lowerBetter: true }) : {};
  const best = rank(Object.fromEntries(makers.map((m) => [m, stat[m].best])), { lowerBetter: true });
  const n = makers.length;
  const b = bands(n);
  makers.sort((a, b2) => (top[a] ?? 99) - (top[b2] ?? 99));
  const rows = makers.map((m) => {
    const s = stat[m];
    let tag = "mid-pack engine", text = "neither strong nor weak on the straights";
    if (b.top(top[m]) && b.top(clip[m])) [tag, text] = ["strongest on the straights", "its cars are fastest at the end of the straight and keep gaining speed furthest down it"];
    else if (b.top(top[m])) [tag, text] = ["quick on the straights", "its cars are among the fastest at the end of the straight"];
    else if (b.bottom(top[m]) && b.bottom(clip[m])) [tag, text] = ["slowest on the straights", "its cars are slow on the straights and stop gaining speed early (short of power, or saving energy there)"];
    else if (b.bottom(top[m])) [tag, text] = ["slow on the straights", "its cars are among the slowest at the end of the straight (drag can play a part too)"];
    if (s.spread != null && s.spread >= 1 && s.topSpread != null && s.topSpread < 6) {
      text += `; its teams are within ${s.topSpread.toFixed(0)} km/h on the straights but ${s.spread.toFixed(1)}% apart over a lap, so the chassis makes the difference`;
    }
    if (best[m] === 1) text += "; powers the fastest car";
    if (s.n === 1) text += " (one team only, so engine and chassis can't be told apart)";
    return { team: m, color: s.color, tag, text,
      cells: [rankCell(top[m], n, s.top != null ? s.top.toFixed(1) : ""),
        ...(clipOk ? [rankCell(clip[m], n, s.clip != null ? s.clip.toFixed(0) + " m" : "")] : []),
        rankCell(best[m], n, s.best != null ? (s.best === 0 ? "fastest" : "+" + s.best.toFixed(2) + "%") : "")] };
  });
  return findingsCard({
    first: "Engine",
    sub: "averaged over each maker's teams · best lap = its quickest team",
    columns: ["Top speed", ...(clipOk ? ["Clipping"] : []), "Best lap"],
    rows,
    note: "Top speed depends on drag as well as power, so a maker whose teams all run low-drag setups can look stronger than it is. The clearest engine signal is several teams with the same engine all fast, or all slow, on the straights." +
      (clipOk ? "" : " Clipping is left out here: it isn't relevant on this track, or it doesn't repeat from lap to lap (see Straights &amp; energy).") +
      (d.top_basis === "race_laps" ? " Top speeds are each team's typical figure over clean racing laps." : "") + loneNote(d.lone_teams),
  });
}

export async function render(el, ctx) {
  const d = await api.sessionData(ctx.key, "engines");
  if (!d.available) {
    el.append(h(`<div class="card note">Power-unit groupings aren't known for this season, or the session has no telemetry.</div>`));
    return;
  }
  const fams = d.families;
  const banner = sessionBanner(ctx, d.top_basis === "race_laps"
    ? "straight-line speed includes slipstream and how each team spends its energy over a race, and lap gaps come from laps set on different fuel and tyres."
    : "lap gaps and straight-line figures come from each team's fastest lap, run on different fuel loads, tyres and programmes.");
  const allTeams = fams.flatMap((f) => f.teams);
  const range = (k) => { const v = allTeams.map((t) => t[k]).filter((x) => x != null); return [Math.min(...v), Math.max(...v)]; };
  const [tLo, tHi] = range("top");
  const [gLo, gHi] = range("gap_pct");
  const cell = (v, lo, hi, lower) => {
    if (v == null) return `<td class="num muted">—</td>`;
    const f = hi === lo ? 1 : lower ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo);
    return `<td class="num" style="color:${f > 0.75 ? C.green : f < 0.25 ? C.red : C.fg1}">`;
  };
  el.append(h(`<div class="grid">
    ${guide("engines", {
      question: "is a team's speed coming from its engine or from its chassis?",
      steps: [
        ["Groups", "Teams that use the same engine maker. The <b>works</b> team is the maker's own; the rest are customers with the same power unit in a different car."],
        ["Lap gap", "How far each team's fastest lap is from the fastest team's, in percent. This is the whole car: engine, aero, tyres and driver."],
        ["Top speed, trap", "Straight-line speed (see Straights &amp; energy). Mostly power and drag."],
        ["Traction, clipping", "Speed 150 m out of slow corners, and metres flat out without gaining speed on the longest straight (lower is better)."],
        ["What it means", "Same engine and similar straight-line speed but a big lap gap: the difference is the <b>chassis</b>. If every team with one engine is quick on the straights, the <b>engine</b> is doing the work."],
      ],
      example: enginesExample(fams),
    })}
    ${conditionsNote(ctx)}
    ${banner.html}
    ${lapNote(d.lap_notes)}
    ${findings(ctx, fams, d)}
    <div class="grid g2">${fams.map((f) => `<div class="card">
      <div class="title"><h2>${esc(f.maker)}</h2><span class="sub">${f.teams.length} team${f.teams.length > 1 ? "s" : ""}</span>
        <div class="tools muted" style="font-size:12px">avg top ${f.top ?? "—"} · gap ${f.gap_pct != null ? f.gap_pct.toFixed(2) + "%" : "—"}</div></div>
      <table class="t"><thead><tr><th>Team</th><th class="num">Lap gap</th><th class="num">Top speed</th>
        <th class="num">Trap</th><th class="num">Traction</th><th class="num">Clipping</th></tr></thead><tbody>
      ${f.teams.sort((a, b) => (a.gap_pct ?? 99) - (b.gap_pct ?? 99)).map((t) => `<tr>
        <td><div class="teamcell"><i style="background:${ctx.teamColor(t.team)}"></i>${esc(t.team)}${t.works ? ` <span class="pill" style="padding:0 7px;font-size:10.5px">works</span>` : ""}</div></td>
        ${cell(t.gap_pct, gLo, gHi, true)}${t.gap_pct != null ? (t.gap_pct === 0 ? "fastest" : "+" + t.gap_pct.toFixed(2) + "%") : ""}</td>
        ${cell(t.top, tLo, tHi)}${t.top ?? "—"}</td>
        <td class="num">${t.trap ?? "—"}</td><td class="num">${t.exit150 ?? "—"}</td>
        <td class="num">${t.flat_longest != null ? t.flat_longest.toFixed(0) + " m" : "—"}</td></tr>`).join("")}
      </tbody></table></div>`).join("")}</div>
  </div>`));
  banner.wire(el);
}
