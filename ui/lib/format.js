// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors

export const C = {
  bgH: "#1d2021", bg0: "#282828", bg0s: "#32302f", bg1: "#3c3836", bg2: "#504945", bg3: "#665c54",
  bg4: "#7c6f64", fg0: "#fbf1c7", fg1: "#ebdbb2", fg2: "#d5c4a1", fg3: "#bdae93", fg4: "#a89984",
  gray: "#928374", red: "#fb4934", green: "#b8bb26", yellow: "#fabd2f", blue: "#83a598",
  purple: "#d3869b", aqua: "#8ec07c", orange: "#fe8019", greenD: "#98971a", aquaD: "#689d6a",
};

export const COMPOUNDS = {
  SOFT: { c: C.red, l: "S" }, MEDIUM: { c: C.yellow, l: "M" }, HARD: { c: C.fg0, l: "H" },
  INTERMEDIATE: { c: C.green, l: "I" }, WET: { c: C.blue, l: "W" },
};
export const compoundColor = (c) => (COMPOUNDS[c] || { c: C.gray }).c;
export function tyre(c) {
  const k = COMPOUNDS[c] || { c: C.gray, l: "?" };
  return `<span class="tyre" style="border-color:${k.c};color:${k.c}" title="${c || "Unknown"}">${k.l}</span>`;
}

export function lapTime(s) {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m ? `${m}:${r.toFixed(3).padStart(6, "0")}` : r.toFixed(3);
}
export function raceTime(s) {
  if (s == null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toFixed(3).padStart(6, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
export const gap = (s) => (s == null ? "—" : (s >= 0 ? "+" : "") + s.toFixed(3));
export const fixed = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d));
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Colours that are too dark on the gruvbox background get lifted.
export function readable(hex) {
  const n = parseInt((hex || "#928374").slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum < 70) {
    const k = 70 / Math.max(lum, 1);
    r = Math.min(255, r * k + 30); g = Math.min(255, g * k + 30); b = Math.min(255, b * k + 30);
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// Colour ramp for speed maps: blue -> aqua -> green -> yellow -> orange -> red
const RAMP = [C.blue, C.aqua, C.green, C.yellow, C.orange, C.red].map((h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
});
export function ramp(t) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t));
  const f = t - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
}
export const GEAR_COLORS = [C.gray, C.blue, C.aqua, C.green, C.yellow, C.orange, C.red, C.purple, C.fg0];

export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
