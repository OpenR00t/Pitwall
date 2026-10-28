# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Summaries of real sessions, for catching changes in the analysis.

`summarise()` boils every analysis of a session down to the numbers and
rankings that matter (results, corner counts, team rankings, pace order,
clipping, season gaps). `test_real.py` compares fresh summaries with the stored
ones in `snapshots/real.json`.

To store summaries for the sessions in your FastF1 cache (after a deliberate
change to a calculation, or for newly downloaded sessions):

    python -m tests.snapshot --update [--cache <folder>]

Sessions are read from the cache only; nothing is downloaded and no F1 TV
sign-in is needed.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np

SNAPSHOT = Path(__file__).parent / "snapshots" / "real.json"

# (year, round, session) for every real session the tests know about
SESSIONS = [
    (2024, 8, "Practice 1"), (2024, 8, "Practice 2"), (2024, 8, "Practice 3"),
    (2024, 8, "Qualifying"), (2024, 8, "Race"),
    (2026, 13, "Qualifying"), (2026, 13, "Race"),
    (2026, 14, "Qualifying"),
    (2026, 15, "Qualifying"), (2026, 15, "Race"),
    (2026, 16, "Qualifying"), (2026, 16, "Race"),
    (2026, 17, "Practice 1"), (2026, 17, "Sprint Qualifying"), (2026, 17, "Sprint"),
    (2026, 17, "Qualifying"), (2026, 17, "Race"),
    (2026, 18, "Practice 2"), (2026, 18, "Qualifying"), (2026, 18, "Race"),
]


def key(year, rnd, name):
    return f"{year}-{rnd:02d}-{name}"


def cache_dir() -> Path:
    from pitwall_backend import source_fastf1
    return Path(os.environ.get("PITWALL_CACHE") or source_fastf1.CACHE_DIR)


def cached(year, rnd, name) -> bool:
    """Whether the session's files are already in the FastF1 cache."""
    folder = cache_dir() / "fastf1" / str(year)
    event = _event_name(year, rnd)
    if not folder.is_dir() or not event:
        return False
    want = "_" + name.replace(" ", "_")
    return any(sess.name.endswith(want) and (sess / "car_data.ff1pkl").exists()
               for ev in folder.iterdir() if ev.is_dir() and ev.name.endswith("_" + event)
               for sess in ev.iterdir())


_events: dict[int, dict[int, str]] = {}


def _event_name(year: int, rnd: int) -> str | None:
    """The event's folder name in the cache, e.g. 'Monaco_Grand_Prix'."""
    import fastf1
    if year not in _events:
        sched = fastf1.get_event_schedule(year, include_testing=False)
        _events[year] = {int(r["RoundNumber"]): str(r["EventName"]).replace(" ", "_")
                         for _, r in sched.iterrows()}
    return _events[year].get(rnd)


def open_cache():
    """Point FastF1 at the cache and skip the sign-in check (cached data only)."""
    import fastf1
    from pitwall_backend import source_fastf1
    folder = str(cache_dir() / "fastf1")   # same layout as the app
    fastf1.Cache.configure(cache_dir=folder) if hasattr(fastf1.Cache, "configure") \
        else fastf1.Cache.enable_cache(folder)
    source_fastf1._require_auth = lambda: None
    return source_fastf1


def _rank(values: dict, lower=False) -> list[str]:
    items = [(t, v) for t, v in values.items() if v is not None and np.isfinite(v)]
    # ties broken by name so the order is the same on every run
    return [t for t, _ in sorted(items, key=lambda x: (x[1] if lower else -x[1], x[0]))]


def summarise(sd) -> dict:
    from pitwall_backend import analysis
    from pitwall_backend.source_fastf1 import quali_gaps

    out = {"event": sd.meta.get("event"), "order": sd.classified_order()[:5]}
    ov = analysis.overview(sd)
    out["wet_share"] = ov["meta"]["wet_share"]
    out["corners_estimated"] = bool(sd.meta.get("corners_estimated"))

    # which laps the car analysis swapped, realigned or left out
    out["lap_notes"] = analysis.lap_notes(sd)
    c = analysis.corners(sd)
    if c.get("available"):
        out["corners"] = {
            "kept": [f'{r["number"]}{r["letter"]}' for r in c["corners"]],
            "linked": c["linked"],
            "classes": {k: sum(1 for r in c["corners"] if r["class"] == k) for k in ("slow", "medium", "fast")},
            "outlier_cells": sum(len(r.get("outliers", [])) for r in c["corners"]),
            "rank": {k: _rank(v)[:3] for k, v in c["summary"].items()},
        }
    st = analysis.straights(sd)
    if st.get("available"):
        out["straights"] = {
            "longest": st["longest_straight"],
            "clipping_relevant": st["clipping_relevant"],
            "top": {t: v["top"] for t, v in st["teams"].items()},
            "flat": {t: v["flat_longest"] for t, v in st["teams"].items()},
        }
    lr = analysis.long_runs(sd)
    if lr.get("available"):
        per = {}
        for s in lr["stints"]:
            p = per.setdefault(s["abbr"], [0.0, 0, s["team"]])
            p[0] += s["median_corrected"] * s["laps"]
            p[1] += s["laps"]
        team = {}
        for _, (total, n, t) in per.items():
            team[t] = min(team.get(t, 9e9), total / n)
        out["long_runs"] = {"stints": len(lr["stints"]), "basis": lr["fuel_basis"],
                            "pace_order": _rank(team, lower=True)[:5]}
    en = analysis.engines(sd)
    if en.get("available"):
        out["engines"] = {f["maker"]: sorted(t["team"] for t in f["teams"]) for f in en["families"]}
    if sd.meta.get("type") in ("Q", "SQ"):
        out["quali_gaps"] = quali_gaps(sd.laps)
    # An independent check of the telemetry: its speed where each fastest lap
    # ends should match the official finish-line speed, apart from a fixed
    # offset per track. The 90th percentile of the remaining scatter, in km/h.
    # This is the raw data, before the lap check: it guards against the data
    # or its slicing getting worse, while bad laps already in a session are
    # handled by the lap check (lap_notes).
    scatter = []
    for d in sd.drivers:
        n = sd.fastest_lap_number(d.abbr)
        tel = None if n is None else sd.lap_telemetry(d.abbr, n)
        row = sd.laps[(sd.laps["Driver"] == d.abbr) & (sd.laps["LapNumber"] == n)]
        if tel is None or tel.empty or row.empty or "SpeedFL" not in row:
            continue
        fl = row["SpeedFL"].iloc[0]
        if np.isfinite(fl):
            scatter.append(float(tel["Speed"].iloc[-1]) - float(fl))
    if len(scatter) >= 5:
        x = np.array(scatter)
        out["line_speed_p90"] = round(float(np.percentile(np.abs(x - np.median(x)), 90)), 1)
    # the delta between the top two must end at their lap-time gap, and pass
    # through the official sector-time gaps. Both hold by construction (the
    # delta is pinned to the timing lines): this guards the pinning, it doesn't
    # show the telemetry is accurate (line_speed_p90 does that)
    order = sd.classified_order()
    cmp = analysis.compare(sd, [(order[0], "fastest"), (order[1], "fastest")])
    # compared laps must be at the same place on track at the same distance:
    # the winner or pole lap against each of the next four, median metres apart
    # (worst pair). The delta checks can't see this: they hold at the line
    seps = []
    for other in order[1:5]:
        tels = []
        for a in (order[0], other):
            n = sd.fastest_lap_number(a)
            t = None if n is None else sd.lap_telemetry(a, n)
            if t is not None and not t.empty:
                tels.append((a, n, t))
        if len(tels) == 2:
            length, aligned = analysis._aligned(sd, tels)
            grid = np.linspace(0, length, 500)
            g = [analysis._on_grid(t, grid) for _, _, t, _, _ in aligned]
            seps.append(float(np.median(np.hypot(g[0]["X"] - g[1]["X"], g[0]["Y"] - g[1]["Y"]))) / 10)
    if seps:
        out["compare_track_gap_m"] = round(max(seps))
    ms = analysis.minisectors(sd, order[:2], 25)
    if ms.get("available"):
        # mini-sector times must add up to each driver's lap time
        errs = []
        for a in order[:2]:
            lt = analysis._lap_time(sd, a, sd.fastest_lap_number(a))
            if lt is not None:
                errs.append(abs(sum(x["times"][a] for x in ms["sectors"]) - lt))
        if errs:
            out["minisector_sum_error"] = round(max(errs), 2)
    if cmp.get("available") and len(cmp["series"]) == 2:
        a, b = cmp["series"]
        if a["laptime"] and b["laptime"]:
            out["delta_end_error"] = round(abs(b["delta"][-1] - (b["laptime"] - a["laptime"])), 2)
            # and pass through the official sector-time gaps at both sector lines
            la, lb = sd.fastest_lap(order[0]), sd.fastest_lap(order[1])
            try:
                ta = np.array(a["time"], float)
                errs = []
                for cols in (["Sector1Time"], ["Sector1Time", "Sector2Time"]):
                    sa = sum(la[c].total_seconds() for c in cols)
                    sb = sum(lb[c].total_seconds() for c in cols)
                    i = min(int(np.searchsorted(ta, sa)), len(ta) - 1)
                    errs.append(abs(b["delta"][i] - (sb - sa)))
                out["delta_sector_error"] = round(max(errs), 2)
            except (TypeError, ValueError, AttributeError):
                pass   # a missing sector time
        # DRS is open/closed (0/1), and only before 2026
        out["drs_open"] = bool(max(a.get("DRS") or [0]) > 0)
    return out


def load(year, rnd, name):
    src = open_cache()
    return src.load(year, rnd, name, lambda m: None)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--update", action="store_true", help="store summaries for cached sessions")
    p.add_argument("--cache", help="FastF1 cache folder (default: Pitwall's)")
    a = p.parse_args()
    if a.cache:
        os.environ["PITWALL_CACHE"] = a.cache
    if not a.update:
        p.print_help()
        return
    open_cache()
    stored = json.loads(SNAPSHOT.read_text()) if SNAPSHOT.exists() else {}
    for year, rnd, name in SESSIONS:
        if not cached(year, rnd, name):
            print(f"skip {key(year, rnd, name)} (not in the cache)")
            continue
        stored[key(year, rnd, name)] = summarise(load(year, rnd, name))
        print(f"stored {key(year, rnd, name)}")
    SNAPSHOT.parent.mkdir(exist_ok=True)
    SNAPSHOT.write_text(json.dumps(stored, indent=1, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
