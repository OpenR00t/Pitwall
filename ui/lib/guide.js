// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
// "How to read this" boxes for the analysis views. Open until the reader
// closes one; the choice is remembered per view.

const KEY = "pitwall.guides.closed";

function closedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch { return new Set(); }
}

document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.classList.contains("guide")) return;
  const s = closedSet();
  if (d.open) s.delete(d.dataset.id); else s.add(d.dataset.id);
  try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* storage unavailable */ }
}, true);

/*
 * guide(id, {
 *   question: "what the view answers",
 *   steps: [["Part of the screen", "what it shows"], ...],
 *   example: "a reading of the loaded session" (html, optional), exampleLabel,
 * })
 */
export function guide(id, { question, steps, example, exampleLabel = "In this session" }) {
  const open = !closedSet().has(id);
  return `<details class="card guide" data-id="${id}" ${open ? "open" : ""}>
    <summary><span class="q">How to read this</span><span class="sub">${question}</span></summary>
    <div class="guide-body">
      <dl>${steps.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${example ? `<div class="example"><div class="label">${exampleLabel}</div>${example}</div>` : ""}
    </div>
  </details>`;
}
