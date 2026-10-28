// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
// Asks the app whether a newer release is out and, if so, offers to install it.
// Only installed copies built for release can update; elsewhere this does nothing.

import * as api from "./api.js";
import { esc, h } from "./format.js";

export async function checkForUpdate() {
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core) return;
  let update = null;
  try {
    update = await tauri.core.invoke("check_update");
  } catch {
    return;   // offline, or the release page can't be reached: try next launch
  }
  if (!update) return;
  const box = h(`<div class="update-toast card" role="dialog" aria-label="Update available">
    <div><b>Pitwall ${esc(update.version)}</b> is available <span class="muted">(you have ${esc(update.current)})</span>.</div>
    ${update.notes ? `<div class="muted notes">${esc(update.notes).slice(0, 400)}</div>` : ""}
    <div class="row" style="gap:8px;margin-top:10px">
      <button class="btn primary small" data-install>Install and restart</button>
      <button class="btn small" data-later>Later</button>
    </div>
    <div class="note muted status" style="margin-top:8px"></div></div>`);
  document.body.append(box);
  box.querySelector("[data-later]").onclick = () => box.remove();
  box.querySelector("[data-install]").onclick = async () => {
    const status = box.querySelector(".status");
    box.querySelectorAll("button").forEach((b) => (b.disabled = true));
    status.textContent = "Downloading the update… Pitwall restarts when it's installed.";
    try {
      await tauri.core.invoke("install_update");
    } catch (e) {
      status.textContent = `The update didn't install: ${e}. Try again later, or download it from the releases page.`;
      box.querySelectorAll("button").forEach((b) => (b.disabled = false));
      await api.init();   // reconnect, in case the backend was restarted on a new port
    }
  };
}
