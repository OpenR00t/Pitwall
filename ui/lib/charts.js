// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
// uPlot charts themed for Gruvbox Cove, plus a canvas track map.

import { C } from "./format.js";

const FONT = '11px "CaskaydiaCove Nerd Font", "Cascadia Code", Consolas, monospace';

function axis(opts = {}) {
  return {
    stroke: C.fg4, font: FONT, labelFont: FONT, size: opts.size ?? 44, gap: 4,
    grid: { stroke: C.bg1, width: 1 }, ticks: { stroke: C.bg2, width: 1, size: 4 },
    ...opts,
  };
}

/*
 * lineChart(el, {
 *   x: [...], series: [{ label, values, color, dash, width, points, fill }],
 *   height, yRange: [min, max], xFmt, yFmt, sync: "key", stepped, onCursor(idx)
 * })
 */
export function lineChart(el, o) {
  const data = [o.x, ...o.series.map((s) => s.values)];
  const series = [
    { label: o.xLabel || "x" },
    ...o.series.map((s) => ({
      label: s.label,
      stroke: s.color,
      width: s.width ?? 1.5,
      dash: s.dash ? [6, 4] : undefined,
      fill: s.fill,
      spanGaps: s.spanGaps ?? false,
      paths: o.stepped ? uPlot.paths.stepped({ align: 1 }) : s.points ? () => null : undefined,
      points: s.points
        ? { show: true, size: s.pointSize ?? 5, stroke: s.color, fill: s.pointFill ?? s.color, width: 1 }
        : { show: false },
    })),
  ];
  const opts = {
    width: Math.max(200, el.clientWidth),
    height: o.height ?? 180,
    series,
    legend: { show: false },
    padding: [o.padTop ?? 8, 8, 0, 0],
    cursor: {
      sync: o.sync ? { key: o.sync, setSeries: false } : undefined,
      points: { size: 6, fill: (u, i) => u.series[i].stroke() },
      drag: { x: !!o.zoom, y: false, setScale: !!o.zoom },
      y: false,
    },
    scales: {
      x: { time: false, ...(o.xRange ? { range: o.xRange } : {}) },
      y: { ...(o.yRange ? { range: o.yRange } : { auto: true }), ...(o.yDir ? { dir: o.yDir } : {}) },
    },
    axes: [
      axis({ size: o.hideX ? 8 : 30, values: o.hideX ? () => [] : o.xFmt ? (u, v) => v.map(o.xFmt) : undefined }),
      axis({ size: o.ySize ?? 52, values: o.yFmt ? (u, v) => v.map(o.yFmt) : undefined,
        ...(o.ySplits ? { splits: () => o.ySplits } : {}) }),
    ],
    hooks: {
      setCursor: [(u) => o.onCursor && o.onCursor(u.cursor.idx, u)],
      ...(o.drawBands ? { drawClear: [(u) => o.drawBands(u)] } : {}),
    },
  };
  el.innerHTML = "";
  const u = new uPlot(opts, data, el);
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    if (w && Math.abs(w - u.width) > 2) u.setSize({ width: w, height: opts.height });
  });
  ro.observe(el);
  u._ro = ro;
  return u;
}

export function destroyCharts(charts) {
  for (const c of charts) { c._ro && c._ro.disconnect(); c.destroy(); }
  charts.length = 0;
}

// Shaded x-ranges (e.g. safety car laps) behind a chart.
export function bandPainter(ranges, color) {
  return (u) => {
    const ctx = u.ctx;
    ctx.save();
    ctx.fillStyle = color;
    for (const [a, b] of ranges) {
      const x0 = u.valToPos(a, "x", true), x1 = u.valToPos(b, "x", true);
      ctx.fillRect(x0, u.bbox.top, Math.max(1, x1 - x0), u.bbox.height);
    }
    ctx.restore();
  };
}

/*
 * Track map on a canvas. segments colour each stretch between points.
 * drawTrack(canvas, { x, y, rotation, colors: [...per point] | color, corners,
 *                     width }) -> { project(i) -> [px, py], redraw(markers) }
 */
export function drawTrack(canvas, o) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 400;
  const cssH = o.height || Math.round(cssW * 0.72);
  canvas.style.height = cssH + "px";
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const rot = ((o.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const pts = o.x.map((x, i) => [x * cos - o.y[i] * sin, x * sin + o.y[i] * cos]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 26;
  const scale = Math.min((cssW - 2 * pad) / (maxX - minX || 1), (cssH - 2 * pad) / (maxY - minY || 1));
  const offX = (cssW - (maxX - minX) * scale) / 2, offY = (cssH - (maxY - minY) * scale) / 2;
  const P = ([x, y]) => [offX + (x - minX) * scale, cssH - (offY + (y - minY) * scale)];
  const proj = pts.map(P);
  const projectXY = (x, y) => P([x * cos - y * sin, x * sin + y * cos]);

  const base = document.createElement("canvas");
  base.width = canvas.width; base.height = canvas.height;
  const b = base.getContext("2d");
  b.scale(dpr, dpr);
  b.lineCap = "round"; b.lineJoin = "round";
  // shadow track
  b.strokeStyle = C.bgH; b.lineWidth = (o.width || 5) + 6;
  b.beginPath(); proj.forEach(([px, py], i) => (i ? b.lineTo(px, py) : b.moveTo(px, py))); b.closePath(); b.stroke();
  b.lineWidth = o.width || 5;
  for (let i = 0; i < proj.length - 1; i++) {
    b.strokeStyle = o.colors ? o.colors[i] : o.color || C.fg3;
    b.beginPath(); b.moveTo(...proj[i]); b.lineTo(...proj[i + 1]); b.stroke();
  }
  // start/finish
  if (proj.length > 2) {
    const [x0, y0] = proj[0], [x1, y1] = proj[2];
    const a = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
    b.strokeStyle = C.fg0; b.lineWidth = 2;
    b.beginPath(); b.moveTo(x0 + Math.cos(a) * 9, y0 + Math.sin(a) * 9);
    b.lineTo(x0 - Math.cos(a) * 9, y0 - Math.sin(a) * 9); b.stroke();
  }
  // corner numbers, pushed off the racing line
  b.font = '600 10.5px "CaskaydiaCove Nerd Font", "Cascadia Code", monospace';
  b.textAlign = "center"; b.textBaseline = "middle";
  const cx = cssW / 2, cy = cssH / 2;
  for (const c of o.corners || []) {
    const [px, py] = projectXY(c.x, c.y);
    const dx = px - cx, dy = py - cy, len = Math.hypot(dx, dy) || 1;
    const lx = px + (dx / len) * 15, ly = py + (dy / len) * 15;
    b.fillStyle = C.bg1; b.beginPath(); b.arc(lx, ly, 8, 0, Math.PI * 2); b.fill();
    b.fillStyle = C.fg3; b.fillText(String(c.number) + (c.letter || ""), lx, ly + 0.5);
  }

  const ctx = canvas.getContext("2d");
  function redraw(markers = []) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const m of markers) {
      const [px, py] = m.i != null ? proj[Math.min(m.i, proj.length - 1)] : projectXY(m.x, m.y);
      ctx.fillStyle = m.color; ctx.strokeStyle = C.bgH; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, m.r || 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (m.label) {
        ctx.font = '700 11px "CaskaydiaCove Nerd Font", "Cascadia Code", monospace';
        ctx.fillStyle = m.color; ctx.textAlign = "left"; ctx.fillText(m.label, px + 9, py - 8);
      }
    }
  }
  redraw();
  return { redraw, project: (i) => proj[i], projectXY };
}
