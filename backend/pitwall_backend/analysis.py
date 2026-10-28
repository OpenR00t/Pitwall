# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Analyses on a loaded session. Every function returns plain JSON data."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .model import CHANNELS, SessionData, arr, num, secs, text

# Corner classes by minimum speed (km/h)
SLOW, FAST = 125.0, 200.0
# Lap time per kg of fuel, and the fuel a car burns over a full race
# (100 kg up to 2025; about 70 kg under the 2026 rules)
SECONDS_PER_KG = 0.035
RACE_FUEL_KG = {2026: 70.0}
RACE_FUEL_KG_BEFORE = 100.0
RACE_DISTANCE_M = 305_000.0
# Power-unit maker -> the works team's name, where it doesn't contain the maker
WORKS = {"Honda": "aston martin", "Red Bull Ford": "red bull racing",
         "Honda RBPT": "red bull racing", "Renault": "alpine"}


# -- overview ------------------------------------------------------------------


def overview(sd: SessionData) -> dict:
    res = []
    if not sd.results.empty:
        for _, r in sd.results.sort_values("Position", na_position="last").iterrows():
            abbr = text(r.get("Abbreviation"))
            if not abbr:
                continue
            fl = sd.fastest_lap(abbr)
            res.append({
                "abbr": abbr,
                "position": num(r.get("Position"), 0),
                "classified": text(r.get("ClassifiedPosition")),
                "grid": num(r.get("GridPosition"), 0),
                "time": secs(r.get("Time")),
                "status": text(r.get("Status")),
                "points": num(r.get("Points"), 1),
                "laps": num(r.get("Laps"), 0),
                "q1": secs(r.get("Q1")), "q2": secs(r.get("Q2")), "q3": secs(r.get("Q3")),
                "fastest": None if fl is None else secs(fl["LapTime"]),
                "fastest_lap": None if fl is None else int(fl["LapNumber"]),
            })
    weather = None
    if sd.weather is not None and not sd.weather.empty:
        w = sd.weather
        weather = {
            "time": [secs(t) for t in w["Time"]],
            **{c: arr(w[c], 1) for c in ("AirTemp", "TrackTemp", "Humidity", "Pressure",
                                         "WindSpeed", "WindDirection") if c in w},
            "rain": [bool(x) for x in w["Rainfall"]] if "Rainfall" in w else [],
        }
    return {
        "meta": {**sd.meta, "wet_share": _wet_share(sd)},
        "drivers": [d.to_json() for d in sd.drivers],
        "order": sd.classified_order(),
        "results": res,
        "weather": weather,
        "race_control": sd.race_control,
        "track_status": sd.track_status,
        "power_units": sd.power_units,
        "total_laps": int(sd.laps["LapNumber"].max()) if not sd.laps.empty else 0,
    }


# -- laps -------------------------------------------------------------------------


def laps(sd: SessionData) -> dict:
    out = {}
    for d in sd.drivers:
        dl = sd.driver_laps(d.abbr)
        if dl.empty:
            continue
        out[d.abbr] = [{
            "n": int(r["LapNumber"]),
            "t": secs(r.get("LapTime")),
            "s1": secs(r.get("Sector1Time")), "s2": secs(r.get("Sector2Time")),
            "s3": secs(r.get("Sector3Time")),
            "end": secs(r.get("Time")),
            "compound": _compound(r.get("Compound")),
            "life": num(r.get("TyreLife"), 0),
            "stint": num(r.get("Stint"), 0),
            "pit_in": pd.notna(r.get("PitInTime")),
            "pit_out": pd.notna(r.get("PitOutTime")),
            "pos": num(r.get("Position"), 0),
            "status": text(r.get("TrackStatus")) or "",
            "accurate": bool(r.get("IsAccurate")) if pd.notna(r.get("IsAccurate")) else False,
            "deleted": bool(r.get("Deleted")) if pd.notna(r.get("Deleted")) else False,
            "i1": num(r.get("SpeedI1"), 1), "i2": num(r.get("SpeedI2"), 1),
            "fl": num(r.get("SpeedFL"), 1), "st": num(r.get("SpeedST"), 1),
        } for _, r in dl.iterrows()]
    return {"laps": out}


# -- telemetry ------------------------------------------------------------------


def _resolve_lap(sd: SessionData, abbr: str, lap) -> int | None:
    if lap in (None, "", "fastest"):
        return sd.fastest_lap_number(abbr)
    return int(lap)


def telemetry(sd: SessionData, abbr: str, lap) -> dict:
    n = _resolve_lap(sd, abbr, lap)
    tel = None if n is None else sd.lap_telemetry(abbr, n)
    if tel is None or tel.empty:
        return {"abbr": abbr, "lap": n, "available": False}
    return {
        "abbr": abbr, "lap": n, "available": True,
        "distance": arr(tel["Distance"], 1),
        "time": arr(tel["Time"], 3),
        "x": arr(tel["X"], 0), "y": arr(tel["Y"], 0),
        **{c: arr(tel[c].astype(float), 1) for c in CHANNELS if c in tel},
    }


def _on_grid(tel: pd.DataFrame, grid: np.ndarray) -> dict:
    d = tel["Distance"].to_numpy(float)
    order = np.argsort(d)
    d = d[order]
    out = {"Time": np.interp(grid, d, tel["Time"].to_numpy(float)[order])}
    for c in CHANNELS:
        if c not in tel:
            continue
        v = tel[c].astype(float).to_numpy()[order]
        if c in ("Brake", "nGear", "DRS"):
            idx = np.clip(np.searchsorted(d, grid), 0, len(d) - 1)
            out[c] = v[idx]
        else:
            out[c] = np.interp(grid, d, v)
    for c in ("X", "Y"):
        out[c] = np.interp(grid, d, tel[c].to_numpy(float)[order])
    return out


def _sector_marks(sd: SessionData, abbr: str, lap: int, tel: pd.DataFrame) -> list[float] | None:
    """Where the lap crossed the two sector lines, in its own distance: the
    points its telemetry clock reads the official sector 1 and sector 1+2
    times. These come from timing loops in the track, so they hold even when
    the speed data drifts or the lap's telemetry starts in the wrong place."""
    row = sd.laps[(sd.laps["Driver"] == abbr) & (sd.laps["LapNumber"] == lap)]
    if row.empty or "Sector1Time" not in row or "Sector2Time" not in row:
        return None
    s1, s2 = secs(row["Sector1Time"].iloc[0]), secs(row["Sector2Time"].iloc[0])
    if s1 is None or s2 is None:
        return None
    t = tel["Time"].to_numpy(float)
    d = tel["Distance"].to_numpy(float)
    if len(t) < 3 or not np.all(np.diff(t) > 0) or t[-1] <= s1 + s2:
        return None
    marks = [float(np.interp(s1, t, d)), float(np.interp(s1 + s2, t, d))]
    return marks if 0 < marks[0] < marks[1] < d[-1] else None


def _typical_lap_length(sd: SessionData) -> float | None:
    """Median measured length of the drivers' fastest laps."""
    if getattr(sd, "_typical_length", None) is None:
        lengths = [float(t["Distance"].max()) for t in _fastest_tels(sd).values()]
        sd._typical_length = float(np.median(lengths)) if lengths else 0.0
    return sd._typical_length or None


def _aligned(sd: SessionData, tels: list) -> tuple[float, list]:
    """Laps put on the first lap's distance axis.

    Each lap's distance is summed from its own speed samples, so two laps
    disagree on the track length by tens of metres (more when speed and
    position drift apart, or a lap's telemetry starts in the wrong place).
    Each lap is stretched sector by sector onto the first one, so the official
    timing lines sit at the same place on every lap; without sector times the
    whole lap is scaled to the first lap's length.
    """
    ref_tel = tels[0][2]
    length = float(ref_tel["Distance"].max())
    ref_marks = _sector_marks(sd, *tels[0])
    out = []
    for k, (abbr, n, tel) in enumerate(tels):
        own = float(tel["Distance"].max())
        # a lap whose telemetry was cut from a different point than the first
        # lap's (it happens to whole races in the timing feed) is first turned
        # to start where the first lap starts, by track position; its own
        # clock then no longer reads the sector times at the sector lines, so
        # it's scaled as a whole lap
        # only whole laps can be turned; a lap missing a stretch keeps its
        # sector-time alignment, and the Telemetry view flags its length
        whole = abs(own / length - 1) <= LENGTH_CHECK if length else False
        shift = _xy_shift(tel, ref_tel) if k and whole else 0.0
        marks = None
        if shift:
            tel = _rotate(tel, shift, _lap_time(sd, abbr, n))
        else:
            marks = _sector_marks(sd, abbr, n, tel)
            tel = tel.copy()
        if ref_marks and marks:
            tel["Distance"] = np.interp(tel["Distance"], [0.0, *marks, own], [0.0, *ref_marks, length])
        elif own > 0:
            tel["Distance"] = tel["Distance"] * (length / own)
        out.append((abbr, n, tel, own, round(shift)))
    return length, out


def _lap_time(sd: SessionData, abbr: str, n: int) -> float | None:
    row = sd.laps[(sd.laps["Driver"] == abbr) & (sd.laps["LapNumber"] == n)]
    return None if row.empty else secs(row["LapTime"].iloc[0])


def compare(sd: SessionData, specs: list[tuple[str, object]], points: int = 1500) -> dict:
    """Laps on a shared distance axis with the time delta to the first one."""
    tels = []
    for abbr, lap in specs:
        n = _resolve_lap(sd, abbr, lap)
        tel = None if n is None else sd.lap_telemetry(abbr, n)
        if tel is not None and not tel.empty:
            tels.append((abbr, n, tel))
    if not tels:
        return {"available": False, "series": []}
    length, aligned = _aligned(sd, tels)
    grid = np.linspace(0, length, points)
    typical = _typical_lap_length(sd)
    ref = None
    series = []
    for abbr, n, tel, own, shift in aligned:
        g = _on_grid(tel, grid)
        if ref is None:
            ref = g
        series.append({
            "abbr": abbr, "lap": n,
            "laptime": _lap_time(sd, abbr, n),
            "delta": arr(g["Time"] - ref["Time"], 3),
            # a lap measuring well off the field's length has speed and position
            # out of sync: its trace and delta can't be trusted
            "length_off_pct": round((own / typical - 1) * 100, 2) if typical else None,
            # metres this lap's telemetry was turned to line up with the first lap
            "shifted_m": shift,
            "time": arr(g["Time"], 3),
            **{c: arr(g[c], 1) for c in CHANNELS if c in g},
        })
    return {
        "available": True, "distance": arr(grid, 1), "series": series,
        "x": arr(ref["X"], 0), "y": arr(ref["Y"], 0),
        "corners": sd.corners, "rotation": sd.rotation,
    }


# -- track maps -------------------------------------------------------------


def track_map(sd: SessionData, abbr: str | None, lap=None) -> dict:
    abbr = abbr or sd.classified_order()[0]
    t = telemetry(sd, abbr, lap)
    t["corners"] = sd.corners
    t["rotation"] = sd.rotation
    return t


def minisectors(sd: SessionData, abbrs: list[str], count: int = 25) -> dict:
    """Split the lap into equal-length parts; who was quickest through each.
    Laps are aligned as in the delta, so each driver's parts add up to their
    lap time and a part covers the same stretch of track on every lap."""
    tels = []
    for a in abbrs:
        n = sd.fastest_lap_number(a)
        tel = None if n is None else sd.lap_telemetry(a, n)
        if tel is not None and not tel.empty:
            tels.append((a, n, tel))
    if not tels:
        return {"available": False}
    length, aligned = _aligned(sd, tels)
    edges = np.linspace(0, length, count + 1)
    grid = np.linspace(0, length, 800)
    g = _on_grid(aligned[0][2], grid)
    at_edges = {}
    for a, n, tel, _, _ in aligned:
        d = tel["Distance"].to_numpy(float)
        t = tel["Time"].to_numpy(float)
        te = np.interp(edges, d, t)
        # the lap's telemetry clock ends a sample short of the line: finish on
        # the official lap time
        lt = _lap_time(sd, a, n)
        if lt is not None and abs(lt - te[-1]) < 1.0:
            te[-1] = lt
        at_edges[a] = te
    sectors = []
    for i in range(count):
        times = {a: float(te[i + 1] - te[i]) for a, te in at_edges.items()}
        best = min(times, key=times.get)
        sectors.append({"from": round(edges[i], 1), "to": round(edges[i + 1], 1),
                        "fastest": best,
                        "times": {a: round(v, 3) for a, v in times.items()}})
    won = {a: sum(1 for s in sectors if s["fastest"] == a) for a in at_edges}
    return {"available": True, "distance": arr(grid, 1), "x": arr(g["X"], 0),
            "y": arr(g["Y"], 0), "sectors": sectors, "won": won,
            "shifted": {a: sh for a, _, _, _, sh in aligned if sh},
            "corners": sd.corners, "rotation": sd.rotation}


# -- car analysis ---------------------------------------------------------------


# A lap's telemetry is checked before the car analysis uses it. Now and then
# FastF1 cuts a lap's telemetry short or from the wrong stretch (it starts near
# the first corner and misses part of the lap). A whole lap joins up: its speed
# at the start matches its speed at the end (within SPEED_CHECK km/h), and it
# measures about as long as the field's laps. A lap cut from a shifted but
# complete stretch (starting a few hundred metres early or late) passes: it
# still covers every corner and straight once, and corners are found on it by
# position.
SPEED_CHECK = 50.0   # a flying lap after an out-lap can start ~40 km/h faster than it ends
LENGTH_CHECK = 0.025   # share of the lap
PACE_CHECK = 1.07      # of the session's fastest lap


def _ranked_laps(sd: SessionData, abbr: str) -> list[tuple[int, float]]:
    """(lap, seconds) of the driver's valid timed laps, quickest first."""
    dl = sd.driver_laps(abbr)
    dl = dl[dl["LapTime"].notna()]
    if "Deleted" in dl:
        dl = dl[dl["Deleted"] != True]  # noqa: E712 - may hold None
    dl = dl.sort_values("LapTime")
    return [(int(n), t.total_seconds()) for n, t in zip(dl["LapNumber"], dl["LapTime"])]


def _lap_reference(sd: SessionData) -> dict:
    """The field's typical lap length and fastest lap (medians, so a few bad
    laps don't move them)."""
    if getattr(sd, "_lap_ref", None) is None:
        lengths, best = [], []
        for d in sd.drivers:
            ranked = _ranked_laps(sd, d.abbr)
            if not ranked:
                continue
            best.append(ranked[0][1])
            tel = sd.lap_telemetry(d.abbr, ranked[0][0])
            if tel is not None and len(tel) > 2:
                lengths.append(float(tel["Distance"].max()))
        sd._lap_ref = {
            "length": float(np.median(lengths)) if lengths else None,
            "best": min(best) if best else None,
        }
    return sd._lap_ref


def _lap_problem(sd: SessionData, tel: pd.DataFrame | None, seconds: float) -> str | None:
    """Why a lap's telemetry can't be used for the car analysis, or None."""
    ref = _lap_reference(sd)
    if tel is None or len(tel) < 3:
        return "no telemetry"
    if ref["best"] and seconds > ref["best"] * PACE_CHECK:
        return "not a racing lap"
    v0, v1 = float(tel["Speed"].iloc[0]), float(tel["Speed"].iloc[-1])
    if abs(v0 - v1) > SPEED_CHECK:
        return "doesn't join up (part of the lap is missing)"
    if ref["length"] and abs(float(tel["Distance"].max()) / ref["length"] - 1) > LENGTH_CHECK:
        return "measures the wrong length"
    return None


def _checked_laps(sd: SessionData) -> dict:
    """driver -> (lap, telemetry, note): the quickest lap that passes the
    check, trying the next-quickest few when the fastest doesn't. The note
    says what was swapped or left out."""
    if getattr(sd, "_checked", None) is None:
        out = {}
        for d in sd.drivers:
            ranked = _ranked_laps(sd, d.abbr)
            if not ranked:
                continue
            first = None
            for n, secs_ in ranked[:6]:
                tel = sd.lap_telemetry(d.abbr, n)
                why = _lap_problem(sd, tel, secs_)
                if first is None:
                    first = (n, why)
                if why is None:
                    note = None if n == first[0] else f"lap {first[0]} {first[1]}; lap {n} used"
                    shift = _lap_shift(tel, sd.corners or [])
                    if shift:
                        # time and position travel with each sample, so only
                        # the distance axis moves
                        tel = _rotate(tel, shift)
                        # the corner map is estimated from one lap when no
                        # official map exists, so only say the laps differ
                        note = (note + "; " if note else "") + (
                            f"lap {n} telemetry is cut {abs(shift):.0f} m from where the session's fastest lap's is, so it's turned to line up with it"
                            if sd.meta.get("corners_estimated") else
                            f"lap {n} telemetry starts {abs(shift):.0f} m {'past' if shift < 0 else 'before'} the line, so it's turned to start there")
                    out[d.abbr] = (n, tel, note)
                    break
            else:
                out[d.abbr] = (None, None, f"lap {first[0]} {first[1]}; left out")
        sd._checked = out
    return sd._checked


def lap_notes(sd: SessionData) -> dict:
    """driver -> what the lap check did, for drivers where it did something."""
    return {a: note for a, (_, _, note) in _checked_laps(sd).items() if note}


def _fastest_tels(sd: SessionData, abbrs=None):
    """Each driver's quickest lap whose telemetry passes the check."""
    out = {}
    for a, (n, tel, _) in _checked_laps(sd).items():
        if abbrs and a not in abbrs:
            continue
        if tel is not None and not tel.empty:
            out[a] = tel
    return out


def _analysed_lap(sd: SessionData, abbr: str) -> int | None:
    return _checked_laps(sd).get(abbr, (None,))[0]


def _team_best(per_driver: dict, sd: SessionData, better=max) -> dict:
    """Best value per team from a {driver: value} map."""
    teams: dict[str, float] = {}
    for a, v in per_driver.items():
        if v is None or (isinstance(v, float) and np.isnan(v)):
            continue
        team = sd.driver(a).team
        teams[team] = v if team not in teams else better(teams[team], v)
    return teams


def _lone_teams(sd: SessionData, abbrs) -> list[str]:
    """Teams with only one driver in a comparison. Everyone else's figure is
    the better of two drivers, so these start at a small disadvantage."""
    count: dict[str, int] = {}
    for a in abbrs:
        d = sd.driver(a)
        if d is not None:
            count[d.team] = count.get(d.team, 0) + 1
    return sorted(t for t, n in count.items() if n == 1)


def _second_lap_number(sd: SessionData, abbr: str) -> int | None:
    """The driver's next-best lap after the analysed one that passes the lap
    check and is within 2% of it: a second reading of the same car, to see
    how much a measure repeats."""
    used = _analysed_lap(sd, abbr)
    ranked = _ranked_laps(sd, abbr)
    base = next((t for n, t in ranked if n == used), None)
    if base is None:
        return None
    for n, t in ranked:
        if n == used:
            continue
        if t > base * 1.02:
            return None
        if _lap_problem(sd, sd.lap_telemetry(abbr, n), t) is None:
            return n
    return None


def _repeat(first: dict, second: dict) -> float | None:
    """Rank correlation between two readings per driver (1 = same order)."""
    keys = [k for k in first if first[k] is not None and second.get(k) is not None]
    if len(keys) < 6:
        return None
    a = pd.Series([first[k] for k in keys]).rank()
    b = pd.Series([second[k] for k in keys]).rank()
    if a.std() == 0 or b.std() == 0:
        return 0.0
    return round(float(np.corrcoef(a, b)[0, 1]), 2)


def _lap_shift(tel: pd.DataFrame, corners: list[dict]) -> float:
    """Where each corner sits on the lap's own distance, minus where the corner
    map puts it (median, so a corner a crossover track passes twice doesn't
    count). Negative: the telemetry starts that far past the line. 0 for a
    normal lap."""
    if not corners or not {"X", "Y"} <= set(tel.columns) or not all("x" in c for c in corners):
        return 0.0
    d = tel["Distance"].to_numpy(float)
    x, y = tel["X"].to_numpy(float), tel["Y"].to_numpy(float)
    length = float(d[-1])
    shifts = []
    for c in corners:
        i = int(np.argmin((x - c["x"]) ** 2 + (y - c["y"]) ** 2))
        shifts.append((d[i] - c["distance"] + length / 2) % length - length / 2)
    shift = float(np.median(shifts))
    return shift if abs(shift) >= 150 else 0.0


def _rotate(tel: pd.DataFrame, shift: float, lap_time: float | None = None) -> pd.DataFrame:
    """A whole lap whose telemetry was cut away from the line (by `shift`, as
    _lap_shift and _xy_shift give it), turned so its distance counts from the
    other point. A lap's first and last samples are the same place a lap
    apart, so the loop is the lap's length and lap time long."""
    d = tel["Distance"].to_numpy(float)
    length = float(d[-1])
    body = tel.iloc[:-1].copy()            # the last sample closes the loop
    body["Distance"] = (d[:-1] - shift) % length
    period = None
    if "Time" in body:
        t = tel["Time"].to_numpy(float)
        period = float(t[-1])
        if lap_time and abs(lap_time - period) < 1.0:
            period = lap_time
        i0 = int(np.argmin(body["Distance"].to_numpy(float)))
        body["Time"] = (t[:-1] - t[i0]) % period
    body = body.sort_values("Distance").reset_index(drop=True)
    # the new start falls between the last sample and the first: restart the
    # clock exactly there, and add the start and its return a lap later, so
    # the lap is `length` long and `period` seconds with no step at either end
    bd = body["Distance"].to_numpy(float)
    gap_before, gap_after = length - bd[-1], bd[0]
    first, closing = body.iloc[[0]].copy(), body.iloc[[0]].copy()
    first["Distance"], closing["Distance"] = 0.0, length
    if period is not None:
        bt = body["Time"].to_numpy(float)
        span = (period - bt[-1]) + bt[0]          # time across the join
        tau = span * gap_after / (gap_before + gap_after) if gap_before + gap_after > 0 else 0.0
        body["Time"] = bt - bt[0] + tau
        first["Time"], closing["Time"] = 0.0, period
    return pd.concat([first, body, closing], ignore_index=True)


XY_SHIFT_MIN = 150.0   # metres; smaller offsets are left to the sector-time alignment


def _xy_shift(tel: pd.DataFrame, ref: pd.DataFrame) -> float:
    """How far (m) along its own distance `tel` is from `ref` at the same
    place on track: for points every ~100 m of the reference lap, where the
    nearest point of this lap sits, against the reference's distance there
    (median, so a crossover doesn't count). 0 when the laps already line up."""
    if not {"X", "Y"} <= set(tel.columns) or not {"X", "Y"} <= set(ref.columns) or len(tel) < 3:
        return 0.0
    d = tel["Distance"].to_numpy(float)
    x, y = tel["X"].to_numpy(float), tel["Y"].to_numpy(float)
    rd = ref["Distance"].to_numpy(float)
    rx, ry = ref["X"].to_numpy(float), ref["Y"].to_numpy(float)
    length = float(d[-1])
    picks = np.linspace(0, len(rd) - 1, max(10, int(rd[-1] // 100))).astype(int)
    diffs = []
    for k in picks:
        i = int(np.argmin((x - rx[k]) ** 2 + (y - ry[k]) ** 2))
        diffs.append((d[i] - rd[k] + length / 2) % length - length / 2)
    shift = float(np.median(diffs))
    return shift if abs(shift) >= XY_SHIFT_MIN else 0.0


def _corner_positions(tel: pd.DataFrame, corners: list[dict]) -> np.ndarray:
    """Where each corner falls on this lap, in this lap's own distance.

    Distance is integrated from speed, so it drifts by tens of metres between
    cars; the corner's map position is matched to the nearest point of the lap
    instead, searching only near the expected distance (tracks that cross over
    themselves pass the same point twice).
    """
    d = tel["Distance"].to_numpy(float)
    has_xy = all(k in c for c in corners for k in ("x", "y")) and {"X", "Y"} <= set(tel.columns)
    out = np.array([c["distance"] for c in corners], float)
    if not has_xy:
        return out
    x, y = tel["X"].to_numpy(float), tel["Y"].to_numpy(float)
    for k, c in enumerate(corners):
        near = np.flatnonzero(np.abs(d - c["distance"]) < 400)
        if near.size:
            i = near[np.argmin((x[near] - c["x"]) ** 2 + (y[near] - c["y"]) ** 2)]
            out[k] = d[i]
    return out


MIN_DIP = 8.0   # km/h a car must lose through a corner for it to count


def _corner_minimums(tel: pd.DataFrame, corners: list[dict]) -> list[float | None]:
    """Slowest speed through each corner. A corner's stretch runs from 120 m
    before to 80 m after it, cut at the halfway point to its neighbours so close
    corners (esses, chicanes) are measured separately."""
    d = tel["Distance"].to_numpy(float)
    v = tel["Speed"].to_numpy(float)
    pos = _corner_positions(tel, corners)
    out = []
    for k, p in enumerate(pos):
        lo, hi = p - 120, p + 80
        if k > 0:
            lo = max(lo, (pos[k - 1] + p) / 2)
        if k + 1 < len(pos):
            hi = min(hi, (p + pos[k + 1]) / 2)
        idx = np.flatnonzero((d >= lo) & (d <= hi))
        if idx.size < 2:
            out.append(None)
            continue
        i = idx[np.argmin(v[idx])]
        # the slowest point sitting on a cut edge means the car is still braking
        # for, or accelerating out of, the neighbouring corner: this one has no
        # slowest point of its own
        cut_lo = k > 0 and lo > p - 120
        cut_hi = k + 1 < len(pos) and hi < p + 80
        if (i == idx[0] and cut_lo) or (i == idx[-1] and cut_hi):
            out.append(None)
            continue
        # the car has to actually slow down here: a lap whose speed hardly dips
        # through a corner the field brakes for has speed and position out of
        # sync (a known timing quirk), and is left out for this corner
        around = (d >= p - 250) & (d <= p + 150)
        if around.any() and float(v[around].max()) - float(v[i]) < MIN_DIP:
            out.append(None)
            continue
        out.append(float(v[i]))
    return out


def corners(sd: SessionData) -> dict:
    """Minimum speed through every corner on each driver's fastest lap."""
    tels = _fastest_tels(sd)
    if not tels or not sd.corners:
        return {"available": False}
    cs = sorted(sd.corners, key=lambda c: c["distance"])
    mins_by_driver = {a: _corner_minimums(tel, cs) for a, tel in tels.items()}
    rows, linked = [], []
    for k, c in enumerate(cs):
        mins = {a: m[k] for a, m in mins_by_driver.items() if m[k] is not None}
        if len(mins) < max(1, len(mins_by_driver) / 2):
            # most cars have no slowest point here: it runs into its neighbour
            linked.append(f'{c["number"]}{c.get("letter", "")}')
            continue
        # one reading far above the rest of the field is a timing glitch, not a
        # car 50 km/h faster than everyone: drop it so it can't be the reference
        vals = np.array(list(mins.values()), float)
        median = float(np.median(vals))
        spread = float(np.median(np.abs(vals - median))) * 1.4826
        mins = {a: v for a, v in mins.items() if v <= median + max(15.0, 4.0 * spread)}
        cls = "slow" if median < SLOW else "fast" if median > FAST else "medium"
        team = _team_best(mins, sd)
        top = max(team.values())
        rows.append({"number": c["number"], "letter": c.get("letter", ""),
                     "distance": round(c["distance"], 1), "class": cls, "median": round(median, 1),
                     "drivers": {a: round(v, 1) for a, v in mins.items()},
                     "teams": {t: round(v - top, 1) for t, v in team.items()}})

    # A class needs at least two corners to say anything about a car: a lone
    # fast or slow corner joins the medium group
    for cls in ("fast", "slow"):
        group = [r for r in rows if r["class"] == cls]
        if len(group) == 1:
            group[0]["class"] = "medium"

    # A single corner far worse than a team's usual gap is more likely a lift,
    # a mistake or a different line than a trait of the car: flag it and leave
    # it out of the averages.
    teams = sorted({t for r in rows for t in r["teams"]})
    for t in teams:
        vals = np.array([r["teams"][t] for r in rows if t in r["teams"]], float)
        if vals.size < 4:
            continue
        med = float(np.median(vals))
        mad = float(np.median(np.abs(vals - med))) * 1.4826
        limit = med - max(8.0, 3.0 * mad)
        for r in rows:
            if r["teams"].get(t, 0) < limit:
                r.setdefault("outliers", []).append(t)

    summary = {}
    for cls in ("slow", "medium", "fast"):
        group = [r for r in rows if r["class"] == cls]
        if not group:
            continue
        summary[cls] = {}
        for t in teams:
            v = [r["teams"][t] for r in group if t in r["teams"] and t not in r.get("outliers", [])]
            if v:
                summary[cls][t] = round(float(np.mean(v)), 2)
    return {"available": True, "corners": rows, "summary": summary, "linked": linked,
            "counts": {cls: sum(1 for r in rows if r["class"] == cls) for cls in summary},
            "lone_teams": _lone_teams(sd, tels), "lap_notes": lap_notes(sd),
            "thresholds": {"slow": SLOW, "fast": FAST}}


def _full_throttle_runs(tel: pd.DataFrame, min_len: float = 300.0):
    d = tel["Distance"].to_numpy(float)
    thr = tel["Throttle"].to_numpy(float)
    full = thr >= 97
    runs = []
    start = None
    for i, f in enumerate(full):
        if f and start is None:
            start = i
        if (not f or i == len(full) - 1) and start is not None:
            end = i if f else i - 1
            if d[end] - d[start] >= min_len:
                runs.append((start, end))
            start = None
    return runs


def _stalled_metres(d: np.ndarray, v: np.ndarray) -> float:
    """Metres near top speed where the car, still at full throttle, gains no
    speed over the next 50 m. Counts a stall wherever it happens on the
    straight: some cars run short of electric power mid-straight and recover
    once they deploy again, others fade towards the braking point."""
    if len(d) < 3 or d[-1] - d[0] < 60:
        return 0.0
    grid = np.arange(d[0], d[-1], 10.0)
    vg = np.interp(grid, d, v)
    ahead = np.interp(np.minimum(grid + 50.0, d[-1]), d, v)
    fast = vg >= 0.85 * vg.max()
    stalled = fast & (ahead - vg <= 0.5) & (grid + 50.0 <= d[-1])
    # the last 50 m have less than 50 m ahead: compare the gain per metre to the end
    left = d[-1] - grid
    rate = np.divide(float(v[-1]) - vg, left, out=np.full_like(vg, np.inf), where=left >= 5.0) * 50.0
    tail = fast & (grid + 50.0 > d[-1]) & (rate <= 0.5)
    return float((stalled | tail).sum() * 10.0)


def _full_throttle_segments(tel: pd.DataFrame, min_len: float = 300.0):
    """(distance, speed) arrays of each full-throttle run. A lap starts and ends
    on the finish line, which is often partway down a straight: a run touching
    both ends of the lap is joined back into one straight."""
    d = tel["Distance"].to_numpy(float)
    v = tel["Speed"].to_numpy(float)
    runs = _full_throttle_runs(tel, min_len=0.0)
    segs = [(d[s:e + 1], v[s:e + 1]) for s, e in runs]
    if len(runs) >= 2 and runs[0][0] == 0 and runs[-1][1] == len(d) - 1:
        (hd, hv), (td, tv) = segs[0], segs[-1]
        lap = d[-1] + (d[1] - d[0] if len(d) > 1 else 0.0)
        segs = segs[1:-1] + [(np.concatenate([td, hd + lap]), np.concatenate([tv, hv]))]
    return [(sd_, sv) for sd_, sv in segs if sd_[-1] - sd_[0] >= min_len]


def straights(sd: SessionData) -> dict:
    """Top speed, traction out of slow corners and energy clipping."""
    tels = _fastest_tels(sd)
    if not tels:
        return {"available": False}
    slow_corners = []
    cor = corners(sd)
    if cor.get("available"):
        slow = {(r["number"], r["letter"]) for r in cor["corners"] if r["class"] == "slow"}
        slow_corners = sorted((c for c in sd.corners if (c["number"], c.get("letter", "")) in slow),
                              key=lambda c: c["distance"])
    drivers = {}
    race_tops = _race_top_speeds(sd) if sd.is_race else {}
    for a, tel in tels.items():
        d = tel["Distance"].to_numpy(float)
        v = tel["Speed"].to_numpy(float)
        laps_ = sd.driver_laps(a)
        trap = laps_["SpeedST"].max() if "SpeedST" in laps_ else np.nan
        # speed 150 m and 300 m after each slow corner's apex, with the corner
        # found on this lap by position (lap distance drifts between cars)
        exits = []
        if slow_corners:
            for c in _corner_positions(tel, slow_corners):
                m = (d >= c - 120) & (d <= c + 80)
                if not m.any():
                    continue
                apex = d[m][np.argmin(v[m])]
                if apex + 300 <= d[-1]:
                    exits.append((float(np.interp(apex + 150, d, v)), float(np.interp(apex + 300, d, v))))
        # clipping: on each long full-throttle run, how far the car went at
        # (nearly) flat speed, and how much speed it lost before braking
        runs = []
        for seg_d, seg_v in _full_throttle_segments(tel):
            peak = int(np.argmax(seg_v))
            # "flat": metres still at full throttle after the car stopped
            # gaining speed; "lost": speed given up before lifting. Both are
            # near zero unless the car is power-limited (energy clipping).
            runs.append({"from": round(float(seg_d[0]), 1), "to": round(float(seg_d[-1]), 1),
                         "length": round(float(seg_d[-1] - seg_d[0]), 1),
                         "peak": round(float(seg_v[peak]), 1),
                         "peak_at": round(float(seg_d[peak]), 1),
                         "flat": round(_stalled_metres(seg_d, seg_v), 1),
                         "lost": round(float(seg_v[peak] - seg_v[-1]), 1)})
        longest = max(runs, key=lambda r: r["length"]) if runs else None
        drivers[a] = {
            "team": sd.driver(a).team,
            # in a race one lap's peak swings with tows and energy use: the
            # typical top speed over the driver's clean laps is steadier
            "top": race_tops.get(a, round(float(v.max()), 1)),
            "peak": round(float(v.max()), 1),
            "trap": num(trap, 1),
            "exit150": round(float(np.mean([x[0] for x in exits])), 1) if exits else None,
            "exit300": round(float(np.mean([x[1] for x in exits])), 1) if exits else None,
            "runs": runs,
            "flat_longest": longest["flat"] if longest else None,
            "lost_longest": longest["lost"] if longest else None,
        }
    teams = {}
    for key in ("top", "trap", "exit150", "exit300"):
        for t, val in _team_best({a: v[key] for a, v in drivers.items()}, sd).items():
            teams.setdefault(t, {})[key] = val
    for key in ("flat_longest", "lost_longest"):
        for t, val in _team_best({a: v[key] for a, v in drivers.items()}, sd, min).items():
            teams.setdefault(t, {})[key] = val
    # on tracks without a long straight nobody runs the battery down, and the
    # clipping figures are all near zero: say so rather than rank noise
    flats = [v["flat_longest"] for v in drivers.values() if v["flat_longest"] is not None]
    longest = max((r["length"] for v in drivers.values() for r in v["runs"]), default=0.0)
    clipping = bool(flats) and float(np.median(flats)) >= 40.0 and longest >= 700
    # the same measure on each driver's second-best lap: if the order doesn't
    # repeat, ranking the teams on it would only rank noise
    second, diffs = {}, []
    for a in drivers:
        n = _second_lap_number(sd, a)
        tel = None if n is None else sd.lap_telemetry(a, n)
        if tel is None or tel.empty:
            continue
        segs = _full_throttle_segments(tel)
        if segs:
            seg_d, seg_v = max(segs, key=lambda x: x[0][-1] - x[0][0])
            second[a] = _stalled_metres(seg_d, seg_v)
            if drivers[a]["flat_longest"] is not None:
                diffs.append(abs(second[a] - drivers[a]["flat_longest"]))
    return {"available": True, "drivers": drivers, "teams": teams,
            "top_basis": "race_laps" if race_tops else "fastest_lap",
            "clipping_relevant": clipping, "longest_straight": round(longest),
            "clipping_repeat": _repeat({a: v["flat_longest"] for a, v in drivers.items()}, second),
            "clipping_noise": round(float(np.median(diffs)), 1) if diffs else None,
            "lone_teams": _lone_teams(sd, tels), "lap_notes": lap_notes(sd)}


def _race_top_speeds(sd: SessionData, min_laps: int = 5) -> dict:
    """Each driver's typical top speed over clean racing laps: the median of
    the highest official speed reading (the intermediates, finish line and
    speed trap) on each lap."""
    cols = [c for c in ("SpeedI1", "SpeedI2", "SpeedFL", "SpeedST") if c in sd.laps]
    if not cols:
        return {}
    L = sd.laps
    ok = L["LapTime"].notna() & L["PitInTime"].isna() & L["PitOutTime"].isna()
    ok &= L["TrackStatus"].fillna("1").astype(str).str.fullmatch(r"1+")
    out = {}
    for a, g in L[ok].groupby("Driver"):
        v = g[cols].max(axis=1).dropna()
        if len(v) >= min_laps:
            out[a] = round(float(v.median()), 1)
    return out


def _wet_share(sd: SessionData) -> float:
    """Share of timed laps run on intermediate or wet tyres."""
    if sd.laps.empty or "Compound" not in sd.laps:
        return 0.0
    timed = sd.laps[sd.laps["LapTime"].notna()]
    if timed.empty:
        return 0.0
    wet = timed["Compound"].map(_compound).isin(["INTERMEDIATE", "WET"])
    return round(float(wet.mean()), 3)


def _compound(value) -> str:
    """Tyre compound name; FastF1 writes unknown tyres as missing or 'None'."""
    c = (text(value) or "").upper()
    return c if c and c not in ("NONE", "NAN", "UNKNOWN", "TEST_UNKNOWN") else "UNKNOWN"


def _slope(x: np.ndarray, y: np.ndarray) -> float:
    """Least-squares slope, 0 when there's nothing to fit."""
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < 2 or np.ptp(x[m]) == 0:
        return 0.0
    try:
        return float(np.polyfit(x[m], y[m], 1)[0])
    except (np.linalg.LinAlgError, ValueError):
        return 0.0


def default_fuel(sd: SessionData) -> float:
    """Seconds of lap time per lap of fuel burned: a full race's fuel spread
    over the race's laps, times the lap time each kg costs."""
    year = int(sd.meta.get("year") or 0)
    kg = next((v for y, v in sorted(RACE_FUEL_KG.items(), reverse=True) if year >= y), RACE_FUEL_KG_BEFORE)
    laps_ = None
    if sd.meta.get("type") == "R" and not sd.laps.empty:
        laps_ = float(sd.laps["LapNumber"].max())
    else:
        length = _typical_lap_length(sd)
        if length:
            laps_ = float(np.ceil(RACE_DISTANCE_M / length))
    if not laps_:
        laps_ = 60.0
    return round(kg / laps_ * SECONDS_PER_KG, 3)


def _gaps_ahead(sd: SessionData) -> dict:
    """(driver, lap) -> seconds behind the car ahead on the same lap, at the line."""
    lp = sd.laps[sd.laps["Time"].notna()][["Driver", "LapNumber", "Time"]]
    out = {}
    for n, g in lp.groupby("LapNumber"):
        g = g.sort_values("Time")
        t = g["Time"].dt.total_seconds().to_numpy()
        for i, a in enumerate(g["Driver"]):
            out[(a, int(n))] = None if i == 0 else float(t[i] - t[i - 1])
    return out


TRAFFIC_GAP = 1.5   # seconds behind the car ahead that holds a car up


def long_runs(sd: SessionData, fuel: float | None = None, min_laps: int = 5) -> dict:
    """Clean stints: pace and tyre degradation with the fuel effect removed."""
    if fuel is None:
        fuel = default_fuel(sd)
    stints = []
    race_end = float(sd.laps["LapNumber"].max()) if sd.is_race and not sd.laps.empty else None
    gaps = _gaps_ahead(sd) if race_end is not None else {}
    for d in sd.drivers:
        dl = sd.driver_laps(d.abbr)
        if dl.empty or "Stint" not in dl:
            continue
        best = dl["LapTime"].min()
        if pd.isna(best):
            continue
        limit = best.total_seconds() * 1.07
        for stint_no, s in dl.groupby("Stint"):
            ok = s["LapTime"].notna() & s["PitInTime"].isna() & s["PitOutTime"].isna()
            ok &= s["TrackStatus"].fillna("1").astype(str).str.fullmatch(r"1+")
            if "IsAccurate" in s:
                ok &= s["IsAccurate"].fillna(False).astype(bool)
            if "Deleted" in s:
                ok &= ~s["Deleted"].fillna(False).astype(bool)
            clean = s[ok].copy()
            clean = clean[clean["LapTime"].dt.total_seconds() <= limit]
            if len(clean) < min_laps:
                continue
            t = clean["LapTime"].dt.total_seconds().to_numpy()
            lapn = clean["LapNumber"].to_numpy(float)
            # tyre age is sometimes missing; count on from the stint's laps instead
            life = clean["TyreLife"].to_numpy(float) if "TyreLife" in clean else np.full(len(lapn), np.nan)
            known = np.isfinite(life)
            offset = float(np.median(life[known] - lapn[known])) if known.any() else 1 - lapn[0]
            life = np.where(known, life, lapn + offset)
            if race_end is not None:
                # every lap brought to an empty tank, so stints from different
                # points of the race compare fairly
                corrected = t - fuel * (race_end - lapn)
            else:
                # practice: fuel loads are unknown, so correct within the stint only
                corrected = t + fuel * (lapn - lapn[0])
            slope = _slope(life, corrected)
            close = [gaps.get((d.abbr, int(n))) for n in lapn]
            close = [g for g in close if g is not None]
            stints.append({
                # share of the stint's clean laps spent close behind another car
                "traffic": round(sum(1 for g in close if g < TRAFFIC_GAP) / len(lapn), 2) if race_end else None,
                # how far into the race the stint started (0 = start, 1 = flag)
                "start_share": round(float(lapn[0]) / race_end, 2) if race_end else None,
                "tyre_start": num(life[0], 0),
                "abbr": d.abbr, "team": d.team, "stint": int(stint_no),
                "compound": next((c for c in map(_compound, clean["Compound"]) if c != "UNKNOWN"), "UNKNOWN"),
                "from": int(lapn[0]), "to": int(lapn[-1]), "laps": len(clean),
                "median": round(float(np.median(t)), 3),
                "median_corrected": round(float(np.median(corrected)), 3),
                "deg": round(slope, 4),
                "points": [{"lap": int(n), "life": num(l, 0), "t": round(float(x), 3),
                            "c": round(float(c), 3)}
                           for n, l, x, c in zip(lapn, life, t, corrected)],
            })
    return {"available": bool(stints), "fuel": fuel, "fuel_default": default_fuel(sd),
            "stints": stints, "fuel_basis": "race" if race_end is not None else "stint"}


def engines(sd: SessionData) -> dict:
    """Teams grouped by power unit, to separate engine from chassis."""
    st = straights(sd)
    if not st.get("available") or not sd.power_units:
        return {"available": False}
    best_lap = {}
    for d in sd.drivers:
        fl = sd.fastest_lap(d.abbr)
        if fl is not None:
            v = fl["LapTime"].total_seconds()
            best_lap[d.team] = min(best_lap.get(d.team, 9e9), v)
    top_lap = min(best_lap.values()) if best_lap else None
    families: dict[str, dict] = {}
    for team, maker in sd.power_units.items():
        if team not in st["teams"]:
            continue
        row = dict(st["teams"][team])
        row["team"] = team
        row["works"] = WORKS.get(maker, maker.split()[0].lower()) in team.lower()
        row["gap_pct"] = (round((best_lap[team] / top_lap - 1) * 100, 3)
                          if team in best_lap and top_lap else None)
        families.setdefault(maker, {"maker": maker, "teams": []})["teams"].append(row)
    for f in families.values():
        teams = f["teams"]
        for key in ("top", "trap", "exit150", "flat_longest", "gap_pct"):
            vals = [t[key] for t in teams if t.get(key) is not None]
            f[key] = round(float(np.mean(vals)), 2) if vals else None
    return {"available": True, "families": sorted(families.values(),
                                                  key=lambda f: f["gap_pct"] or 99),
            "top_basis": st["top_basis"], "clipping_relevant": st["clipping_relevant"],
            "clipping_repeat": st["clipping_repeat"], "lone_teams": st["lone_teams"],
            "lap_notes": st["lap_notes"]}


def race(sd: SessionData) -> dict:
    """Positions and gap to the leader at the end of every lap."""
    lp = sd.laps[sd.laps["Time"].notna()]
    if lp.empty:
        return {"available": False}
    leader = lp.groupby("LapNumber")["Time"].min()
    out = {}
    for d in sd.drivers:
        dl = lp[lp["Driver"] == d.abbr].sort_values("LapNumber")
        out[d.abbr] = {
            "lap": [int(n) for n in dl["LapNumber"]],
            "pos": [num(p, 0) for p in dl["Position"]],
            "gap": [secs(t - leader[n]) for n, t in zip(dl["LapNumber"], dl["Time"])],
        }
    return {"available": True, "drivers": out}
