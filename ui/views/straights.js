// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import * as api from "../lib/api.js";
import { destroyCharts, lineChart } from "../lib/charts.js";
import { esc, h } from "../lib/format.js";
import { guide } from "../lib/guide.js";
import { bands, findingsCard, rank, rankCell, conditionsNote, loneNote, sessionBanner, lapNote } from "../lib/findings.js";

function bars(ctx, teams, key, unit, { lowerBetter = false, digits = 1 } = {}) {
  const list = Object.entries(teams).filter(([, v]) => v[key] != null)
    .sort((a, b) => (lowerBetter ? a[1][key] - b[1][key] : b[1][key] - a[1][key]));
  if (!list.length) return `<div class="muted">No data</div>`;
  const vals = list.map(([, v]) => v[key]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  return `<div class="bars">${list.map(([t, v]) => {
    const f = lowerBetter ? (hi - v[key]) / span : (v[key] - lo) / span;
    return `<div class="bar-row"><span class="name">${esc(t)}</span>
      <span class="track"><span class="fill" style="left:0;width:${8 + f * 92}%;background:${ctx.teamColor(t)}"></span></span>
      <span class="val">${v[key].toFixed(digits)}${unit}</span></div>`;
  }).join("")}</div>`;
}

const clipRepeatsOf = (d) => d.clipping_repeat == null || d.clipping_repeat >= 0.6;

function straightsExample(teams, clipOk = true) {
  const list = Object.entries(teams);
  const pick = (k, lower) => list.filter(([, v]) => v[k] != null)
    .sort((a, b) => (lower ? a[1][k] - b[1][k] : b[1][k] - a[1][k]));
  const top = pick("top"), clip = pick("flat_longest", true), trac = pick("exit150");
  if (!top.length) return "";
  let out = `<b>${esc(top[0][0])}</b> has the highest top speed (${top[0][1].top.toFixed(0)} km/h).`;
  if (clip.length > 1 && clipOk) {
    const lo = clip[0][1].flat_longest, hi = clip.at(-1)[1].flat_longest;
    const names = (v) => {
      const n = clip.filter(([, x]) => x.flat_longest === v).map(([t]) => `<b>${esc(t)}</b>`);
      return n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n.at(-1)}` : n[0];
    };
    const many = (v) => clip.filter(([, x]) => x.flat_longest === v).length > 1;
    out += ` ${names(lo)} clip${many(lo) ? "" : "s"} least (${lo.toFixed(0)} m flat without gaining speed) and
      ${names(hi)} most (${hi.toFixed(0)} m).`;
  }
  if (trac.length > 1 && trac[0][0] !== top[0][0]) {
    out += ` Out of slow corners <b>${esc(trac[0][0])}</b> is best, so it gets going sooner even if it isn't fastest at the end of the straight.`;
  }
  return out;
}

// what straight-line speed, traction and clipping say about each car, read
// together with how it does in fast corners (from the corners analysis)
async function findings(ctx, d) {
  const T = d.teams;
  const pick = (k) => Object.fromEntries(Object.entries(T).map(([t, v]) => [t, v[k]]));
  const top = rank(pick("top")), trac = rank(pick("exit150")), clip = rank(pick("flat_longest"), { lowerBetter: true });
  let fast = {};
  try {
    const c = await api.sessionData(ctx.key, "corners");
    if (c.available) fast = rank(c.summary.fast || c.summary.medium || {});
  } catch { /* corners unavailable: read the straights alone */ }
  const teams = Object.keys(T).sort((a, b) => (top[a] ?? 99) - (top[b] ?? 99));
  const n = teams.length;
  const b = bands(n);
  // a rank only counts as quick or slow when it's a real margin: speeds are
  // logged in whole km/h, so within 3 km/h of the field's middle is a tie
  const tops = Object.values(T).map((v) => v.top).filter((v) => v != null).sort((p, q) => p - q);
  const mid = tops.length ? tops[Math.floor(tops.length / 2)] : 0;
  const quick = (t) => b.top(top[t]) && T[t].top - mid >= 3;
  const slow = (t) => b.bottom(top[t]) && mid - T[t].top >= 3;
  // clipping is only ranked where it means something (a long straight) and
  // where it repeats: each driver's second-best lap has to put the cars in
  // roughly the same order
  const clipRepeats = d.clipping_repeat == null || d.clipping_repeat >= 0.6;
  const clipOk = d.clipping_relevant !== false && clipRepeats;
  const flats = Object.values(T).map((v) => v.flat_longest).filter((v) => v != null).sort((p, q) => p - q);
  const flatMid = flats.length ? flats[Math.floor(flats.length / 2)] : 0;
  const clipMargin = Math.max(50, flatMid * 0.1, 2 * (d.clipping_noise || 0));
  const clipsMore = (t) => clipOk && b.bottom(clip[t]) && T[t].flat_longest - flatMid >= clipMargin;
  const clipsLess = (t) => clipOk && b.top(clip[t]) && flatMid - T[t].flat_longest >= clipMargin;
  const rows = teams.map((t) => {
    const s = top[t], f = fast[t], x = clipOk ? clip[t] : null, tr = trac[t];
    let tag = "middle of the pack", text = "nothing stands out on the straights";
    if (quick(t) && b.bottom(f)) [tag, text] = ["low-drag trim", "fast on the straights but slow in fast corners: likely running less wing"];
    else if (slow(t) && b.top(f)) [tag, text] = ["high-downforce trim", "quick in fast corners but slow on the straights: more wing, more drag"];
    else if (quick(t) && b.top(f)) [tag, text] = ["efficient", "quick on the straights and in fast corners: good aero efficiency or a strong engine"];
    else if (slow(t) && b.bottom(f)) [tag, text] = ["inefficient", "slow on the straights and in fast corners alike"];
    else if (quick(t)) [tag, text] = ["quick in a straight line", "among the fastest at the end of the straight"];
    else if (slow(t)) [tag, text] = ["slow in a straight line", "among the slowest at the end of the straight"];
    if (clipsMore(t)) text += "; stops gaining speed earlier on the straight than most (the battery running low, or energy saved there by choice)";
    else if (clipsLess(t)) text += "; keeps gaining speed further down the straight than most";
    if (b.top(tr) && !b.top(s)) text += "; strong out of slow corners";
    return { team: t, color: ctx.teamColor(t), tag, text,
      cells: [rankCell(s, n, T[t].top?.toFixed(0)), rankCell(tr, n, T[t].exit150?.toFixed(0)),
        ...(clipOk ? [rankCell(x, n, T[t].flat_longest != null ? T[t].flat_longest.toFixed(0) + " m" : "")] : []),
        Object.keys(fast).length ? rankCell(f, n) : ""] };
  });
  return findingsCard({
    sub: "rank on each measure · compared with fast-corner speed from Corners",
    columns: ["Top speed", "Traction", ...(clipOk ? ["Clipping"] : []), ...(Object.keys(fast).length ? ["Fast corners"] : [])],
    rows,
    note: (d.clipping_relevant === false ? `No straight here is long enough to run the battery down (longest ${d.longest_straight} m flat out), so clipping is left out. `
      : !clipRepeats ? `Clipping is left out: on each driver's second-best lap the cars come out in a different order (agreement ${d.clipping_repeat.toFixed(2)}, where 1 is the same order), so the figures don't separate the cars. `
      : "") +
      (d.top_basis === "race_laps" ? "Top speed here is each driver's typical top speed over clean racing laps, not one lap's peak: one lap swings by several km/h with tows and energy use. " : "") +
      "Top speed and corner speed pull against each other: more wing means more grip and more drag. Reading them together separates a <b>setup choice</b> (low or high downforce) from a car that is simply quick or slow." + loneNote(d.lone_teams),
  });
}

export async function render(el, ctx) {
  const d = await api.sessionData(ctx.key, "straights");
  const charts = [];
  if (!d.available) { el.append(h(`<div class="card note">No telemetry for this session.</div>`)); return; }
  const found = await findings(ctx, d);
  const race = d.top_basis === "race_laps";
  const banner = sessionBanner(ctx, race
    ? "straight-line speed includes slipstream from cars ahead and how each team spends its energy over a race, and traction and clipping come from one lap."
    : "top speed, traction and clipping come from each driver's fastest lap, run on different fuel loads, tyres and programmes.");
  const hybrid = (ctx.ov.meta.year ?? 2026) >= 2026
    ? "From 2026 about half a car's power is electric, and the battery can run low on a long straight."
    : "The hybrid system adds electric power on top of the engine, but only so much energy per lap, so the boost can run out before the end of a long straight.";
  const card = (title, sub, body) => `<div class="card"><div class="title"><h2>${title}</h2><span class="sub">${sub}</span></div>${body}</div>`;
  el.append(h(`<div class="grid">
    ${guide("straights", {
      question: "which car is quickest in a straight line, and why?",
      steps: [
        ["Top speed", race
          ? "Each team's typical top speed over its clean racing laps (the median of each lap's highest official speed reading). One lap's peak swings by several km/h with tows. High top speed comes from low drag (less wing) or more power."
          : "Fastest point on each team's best lap. High top speed comes from low drag (less wing) or more power."],
        ["Speed trap", "Highest speed through the trap all session, on any lap. Tows from cars ahead can inflate it."],
        ["Traction", "Speed 150 m after the slow corners: how well the car puts power down coming out of them."],
        ["Energy clipping", `${hybrid} The car then stops gaining speed with the throttle still flat. This counts how many metres of the longest straight are spent like that: <b>lower is usually better</b>. A car can also stop gaining speed because it has reached its top speed for its drag, or because the team saves energy on that straight to spend elsewhere, so read it alongside top speed.`],
        ["The trace", "Speed down the longest straight for the ticked drivers. A line that flattens early and sags before the braking point is clipping; one still climbing at the braking point isn't."],
      ],
      example: straightsExample(d.teams, d.clipping_relevant !== false && clipRepeatsOf(d)),
    })}
    ${conditionsNote(ctx)}
    ${banner.html}
    ${lapNote(d.lap_notes)}
    ${found}
    <div class="grid g2">
      ${card("Top speed", race ? "typical over clean racing laps, km/h" : "best on any fastest lap, km/h", bars(ctx, d.teams, "top", ""))}
      ${card("Speed trap", "highest through the trap all session", bars(ctx, d.teams, "trap", ""))}
      ${card("Traction", "speed 150 m after slow corners", bars(ctx, d.teams, "exit150", ""))}
      ${card("Energy clipping", "metres at full throttle without gaining speed, longest straight · lower is better",
        d.clipping_relevant === false
          ? `<div class="note muted">No straight here is long enough to run the battery down (the longest full-throttle run is
              ${d.longest_straight} m), so the cars barely clip and the numbers would only rank noise.</div>`
          : bars(ctx, d.teams, "flat_longest", " m", { lowerBetter: true, digits: 0 }) + (clipRepeatsOf(d) ? "" :
            `<div class="note muted" style="font-size:12.5px;margin-top:8px">These don't repeat: on each driver's second-best lap the cars
              come out in a different order (agreement ${d.clipping_repeat.toFixed(2)}, where 1 is the same order), so read them as one lap's figures, not a ranking.</div>`))}
    </div>
    <div class="card"><div class="title"><h2>Down the longest straight</h2><span class="sub" id="ssub"></span></div>
      <div class="legend" id="sleg"></div><div id="schart"></div>
      <div class="note" style="margin-top:10px;font-size:12.5px">${hybrid} The car then stops
      accelerating (or slows) with the throttle still flat: <b>clipping</b>. A trace that flattens early
      and droops before the braking point is clipping; one still climbing at the braking point isn't.</div></div>
  </div>`));

  banner.wire(el);
  const sel = (ctx.selected.length ? ctx.selected : ctx.ov.order.slice(0, 3)).slice(0, 5).filter((a) => d.drivers[a]);
  if (!sel.length) return;
  const runs = d.drivers[sel[0]].runs || [];
  if (!runs.length) return;
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
  const cmp = await api.sessionData(ctx.key, "compare", "laps=" + encodeURIComponent(sel.map((a) => a + ":fastest").join(",")));
  if (!cmp.available) return;
  const from = Math.max(0, longest.from - 150), to = longest.to + 120;
  const idx = cmp.distance.map((v, i) => [v, i]).filter(([v]) => v >= from && v <= to).map(([, i]) => i);
  el.querySelector("#ssub").textContent = `${(longest.length / 1000).toFixed(2)} km of full throttle from ${Math.round(longest.from)} m`;
  el.querySelector("#sleg").innerHTML = sel.map((a) => {
    const r = d.drivers[a];
    return `<span><i class="${ctx.dash(a) ? "dash" : ""}" style="background:${ctx.color(a)};color:${ctx.color(a)}"></i>${a}
      <span class="muted">peak ${(r.peak ?? r.top).toFixed(0)} · flat ${r.flat_longest ?? "—"} m · lost ${r.lost_longest ?? "—"} km/h</span></span>`;
  }).join("");
  charts.push(lineChart(el.querySelector("#schart"), {
    x: idx.map((i) => cmp.distance[i]), height: 300, xFmt: (v) => `${(v / 1000).toFixed(2)} km`,
    series: cmp.series.map((s) => ({ label: s.abbr, values: idx.map((i) => s.Speed[i]), color: ctx.color(s.abbr),
      dash: ctx.dash(s.abbr), width: 2 })),
  }));
  return () => destroyCharts(charts);
}
