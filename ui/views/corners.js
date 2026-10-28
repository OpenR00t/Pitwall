// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
import * as api from "../lib/api.js";
import { C, esc, h } from "../lib/format.js";
import { guide } from "../lib/guide.js";
import { conditionsNote, loneNote, sessionBanner, lapNote } from "../lib/findings.js";

const CLASSES = ["slow", "medium", "fast"];
const CLASS_LABEL = { slow: "Slow corners", medium: "Medium corners", fast: "Fast corners" };
const CLASS_NOTE = {
  slow: "mechanical grip, traction, braking",
  medium: "a mix of grip and downforce",
  fast: "downforce and aero balance",
};

// 0 (best) -> green, increasingly slower -> yellow -> red
function heat(delta, worst) {
  const t = Math.min(1, Math.abs(delta) / (worst || 1));
  if (t < 0.02) return `background:rgba(184,187,38,.30);color:${C.fg0}`;
  const a = 0.12 + t * 0.45;
  return t < 0.5 ? `background:rgba(250,189,47,${a})` : `background:rgba(251,73,52,${a})`;
}

const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

// rank of every team in each corner class (1 = closest to the best)
function ranks(summary) {
  const out = {};
  for (const k of CLASSES) {
    if (!summary[k]) continue;
    Object.entries(summary[k]).sort((a, b) => b[1] - a[1]).forEach(([t], i) => {
      (out[t] ||= {})[k] = i + 1;
    });
  }
  return out;
}

// a class needs this many corners, and two classes this many km/h between a
// team's gaps, before a difference counts as a trait of the car rather than
// lap-to-lap noise (minimum speeds move about 2 km/h between a driver's laps)
const MIN_CLASS = 4;
const PROFILE_GAP = 3;

// a short description of what a team's corner ranks say about its car
function profile(r, n, hiName = "fast", summary = null, team = null, counts = null) {
  const third = Math.max(1, Math.floor(n / 3));
  const half = (x) => x != null && x <= n / 2;
  const top = (x) => x != null && x <= third;
  const bottom = (x) => x != null && x > n - third;
  const lo = r.slow ?? r.medium, hi = r.fast ?? r.medium;
  if (lo == null || hi == null) return ["", ""];
  const all = [r.slow, r.medium, r.fast].filter((x) => x != null);
  if (all.every(top)) return ["all-rounder", "quick in every kind of corner: strong grip and strong aero"];
  if (all.every(bottom)) return ["slow everywhere", "off the pace in every kind of corner; no single weakness stands out"];
  let spread = lo - hi;   // positive: better in fast corners than slow
  if (summary && team) {
    const loK = r.slow != null ? "slow" : "medium", hiK = r.fast != null ? "fast" : "medium";
    const few = [loK, hiK].filter((k) => counts && counts[k] != null && counts[k] < MIN_CLASS);
    const gapLo = summary[loK]?.[team], gapHi = summary[hiK]?.[team];
    const kmh = gapLo != null && gapHi != null ? gapHi - gapLo : 0;   // positive: relatively better when fast
    if (Math.abs(spread) >= third && few.length) {
      return ["no clear pattern", `ranks differ, but there ${counts[few[0]] === 1 ? "is" : "are"} only ${few.map((k) => `${counts[k]} ${k} corner${counts[k] === 1 ? "" : "s"}`).join(" and ")}: too few to judge`];
    }
    if (Math.abs(spread) >= third && Math.abs(kmh) < PROFILE_GAP) {
      return ["balanced", `ranks differ, but by under ${PROFILE_GAP} km/h between slow and ${hiName} corners: within lap-to-lap noise`];
    }
    if (Math.abs(spread) >= third && Math.sign(kmh) !== Math.sign(spread)) spread = 0;
  }
  if (spread >= third && half(hi)) return ["high-speed car", `strong aero in ${hiName} corners, weaker at low speed (mechanical grip, traction, rotation)`];
  if (-spread >= third && half(lo)) return ["short of downforce", "good low-speed grip but loses out as corners get faster"];
  if (spread >= third) return ["better when fast", `relatively stronger in ${hiName} corners than slow ones`];
  if (-spread >= third) return ["better when slow", `relatively stronger in slow corners than ${hiName} ones`];
  return ["balanced", `about as good in slow corners as in ${hiName} ones`];
}

const km = (v) => (v > -0.05 ? "nothing" : `${(-v).toFixed(1)} km/h`);

// a reading of the loaded session for the guide box
function cornersExample(d, R, n) {
  const teams = Object.keys(R);
  const tagged = teams.map((t) => [t, profile(R[t], n, d.summary.fast ? "fast" : "medium-speed", d.summary, t, d.counts || {})[0]]);
  const find = (tag) => tagged.filter(([, p]) => p === tag).map(([t]) => t);
  const parts = [];
  const lo = d.summary.slow ? "slow" : "medium", hi = d.summary.fast ? "fast" : "medium";
  const all = find("all-rounder");
  const names = (ts) => { const b = ts.map((t) => `<b>${esc(t)}</b>`); return b.length > 1 ? `${b.slice(0, -1).join(", ")} and ${b.at(-1)}` : b[0]; };
  if (all.length) parts.push(`${names(all)} ${all.length > 1 ? "are" : "is"} quick in every kind of corner.`);
  for (const t of find("short of downforce").slice(0, 1)) {
    parts.push(`<b>${esc(t)}</b> is ${ord(R[t][lo])} in ${lo} corners but ${ord(R[t][hi])} in ${hi} ones (${km(d.summary[hi][t])} behind there): short of downforce.`);
  }
  for (const t of find("high-speed car").slice(0, 1)) {
    parts.push(`<b>${esc(t)}</b> is the reverse, ${ord(R[t][hi])} in ${hi} corners but ${ord(R[t][lo])} in ${lo} ones: strong aero, weaker at low speed.`);
  }
  if (!parts.length) parts.push("No team stands out as much better in one kind of corner than another here.");
  return parts.join(" ");
}

export async function render(el, ctx) {
  const d = await api.sessionData(ctx.key, "corners");
  if (!d.available) {
    el.append(h(`<div class="card note">Corner positions or telemetry aren't available for this session.</div>`));
    return;
  }
  const R = ranks(d.summary);
  const teams = Object.keys(R);
  const n = teams.length;
  const meanRank = (t) => { const v = Object.values(R[t]); return v.reduce((a, b) => a + b, 0) / v.length; };
  teams.sort((a, b) => meanRank(a) - meanRank(b));
  const classes = CLASSES.filter((k) => d.summary[k]);
  const hiName = d.summary.fast ? "fast" : "medium-speed";
  const worst = Math.max(...d.corners.flatMap((c) => Object.values(c.teams).map(Math.abs)));
  const flagged = d.corners.reduce((s, c) => s + (c.outliers || []).length, 0);

  // fastest laps in a race or practice come at different fuel loads, tyres and traffic
  const meta = ctx.ov.meta;
  const banner = sessionBanner(ctx, "each team's fastest lap came at a different point, on different fuel, tyres and traffic, which blurs the comparison.");
  const counts = d.counts || {};

  const rankCell = (t, k) => {
    const r = R[t][k];
    if (r == null) return `<td class="num muted">—</td>`;
    const third = Math.max(1, Math.floor(n / 3));
    const color = r <= third ? C.green : r > n - third ? C.red : C.fg1;
    return `<td class="num"><span style="color:${color}">${ord(r)}</span> <span class="muted">${d.summary[k][t] > -0.05 ? "" : d.summary[k][t].toFixed(1)}</span></td>`;
  };

  const cards = classes.map((k) => {
    const list = Object.entries(d.summary[k]).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...list.map(([, v]) => Math.abs(v)), 0.1);
    const nc = d.corners.filter((c) => c.class === k).length;
    return `<div class="card"><div class="title"><h2>${CLASS_LABEL[k]}</h2><span class="sub">${nc} · ${CLASS_NOTE[k]}</span></div>
      <div class="bars">${list.map(([t, v], i) => `<div class="bar-row" style="grid-template-columns:26px 120px 1fr 52px">
        <span class="muted">${i + 1}</span><span class="name">${esc(t)}</span>
        <span class="track"><span class="fill" style="left:0;width:${Math.max(2, 100 - (Math.abs(v) / max) * 100)}%;background:${ctx.teamColor(t)}"></span></span>
        <span class="val">${v > -0.05 ? "0.0" : v.toFixed(1)}</span></div>`).join("")}</div></div>`;
  }).join("");

  el.append(h(`<div class="grid">
    ${guide("corners", {
      question: "in which kinds of corner is each car quick, and where does it lose time?",
      steps: [
        ["Measured", "Each team's <b>slowest speed through each corner</b> on its fastest lap. The more speed a car carries through a corner, the more grip it has there."],
        ["The gaps", "At every corner the quickest team is the reference and everyone else is km/h behind it. The reference changes from corner to corner, so a team's average gap is never quite 0 unless it was quickest everywhere. Speeds are logged in whole km/h: ignore gaps of 2–3."],
        ["Slow / medium / fast", `Corners grouped by how fast the field takes them (under <b>${d.thresholds.slow}</b> km/h is slow, over <b>${d.thresholds.fast}</b> is fast). Downforce grows with speed, so <b>fast corners test the aero</b>; slow corners test mechanical grip, braking and traction.`],
        ["Reading it", "Compare a team's ranks <b>against each other</b>, not against the field: good everywhere is simply a good car; good in slow but poor in fast is short of downforce; the reverse is a strong high-speed aero car that struggles at low speed."],
      ],
      example: cornersExample(d, R, n),
    })}
    ${conditionsNote(ctx)}
    ${banner.html}
    ${lapNote(d.lap_notes)}
    ${meta.corners_estimated ? `<div class="card warnbox"><span class="note" style="max-width:none">No official corner map is published for
      this layout, so the corners here are the places the fastest lap slows down, numbered in order around the lap.
      They won't match the circuit's own turn numbers, and flat-out kinks aren't included.</span></div>` : ""}
    <div class="card"><div class="title"><h2>Car profiles</h2><span class="sub">rank in each kind of corner · average km/h behind the quickest team</span></div>
      <table class="t"><thead><tr><th>Team</th>${classes.map((k) => `<th class="num">${CLASS_LABEL[k].split(" ")[0]}</th>`).join("")}<th>What it suggests</th></tr></thead>
      <tbody>${teams.map((t) => { const [tag, text] = profile(R[t], n, hiName, d.summary, t, counts); return `<tr>
        <td><div class="teamcell"><i style="background:${ctx.teamColor(t)}"></i>${esc(t)}</div></td>
        ${classes.map((k) => rankCell(t, k)).join("")}
        <td><b style="color:var(--fg1)">${tag}</b> <span class="muted" style="font-family:var(--font-read)">· ${text}</span></td></tr>`; }).join("")}
      </tbody></table>
      <div class="note muted" style="font-size:12.5px;margin-top:8px">A team's minimum speed in a corner moves about 2 km/h from one of its laps to the next
        (5 km/h or more on one lap in ten), so a verdict needs a gap of at least ${PROFILE_GAP} km/h between kinds of corner,
        and at least ${MIN_CLASS} corners of each kind.${loneNote(d.lone_teams)}</div></div>
    <div class="grid g3">${cards}</div>
    <div class="card"><div class="title"><h2>Corner by corner</h2><span class="sub">km/h behind the quickest team · median speed of the field below</span></div>
      <div style="overflow-x:auto"><table class="t heat"><thead><tr><th>Team</th>
      ${d.corners.map((c) => `<th class="num" title="${CLASS_LABEL[c.class]}">T${c.number}${esc(c.letter || "")}</th>`).join("")}</tr>
      <tr><th class="muted" style="font-weight:400">median</th>${d.corners.map((c) => `<th class="num muted" style="font-weight:400">${c.median.toFixed(0)}</th>`).join("")}</tr></thead>
      <tbody>${teams.map((t) => `<tr><td><div class="teamcell"><i style="background:${ctx.teamColor(t)}"></i>${esc(t)}</div></td>
        ${d.corners.map((c) => {
          const v = c.teams[t];
          if (v == null) return `<td class="cell muted">—</td>`;
          if ((c.outliers || []).includes(t)) {
            return `<td class="cell" style="background:var(--bg1);color:var(--gray)" title="Far off this team's usual gap: probably a lift, a mistake or a different line. Left out of the averages.">${v.toFixed(1)}?</td>`;
          }
          return `<td class="cell" style="${heat(v, worst)}">${v === 0 ? "●" : v.toFixed(1)}</td>`;
        }).join("")}</tr>`).join("")}</tbody></table></div>
      ${(d.linked || []).length ? `<div class="note muted" style="font-size:12.5px;margin-top:8px">Not shown: ${d.linked.map((x) => "T" + x).join(", ")}.
        Cars are still braking for, or accelerating out of, the corner next to ${d.linked.length > 1 ? "them" : "it"}, so ${d.linked.length > 1 ? "they have" : "it has"} no slowest point of ${d.linked.length > 1 ? "their" : "its"} own.</div>` : ""}
      ${flagged ? `<div class="note muted" style="font-size:12.5px;margin-top:8px">Grey cells with <b>?</b> are far off that team's usual gap,
        more likely a lift, a mistake or a different line than a trait of the car. They're left out of the averages and ranks.</div>` : ""}</div>
  </div>`));
  banner.wire(el);
}
