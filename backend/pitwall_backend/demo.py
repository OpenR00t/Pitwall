# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""A synthetic, FastF1-shaped data source for trying the app without an
F1 TV account (and for its screenshots and tests).

Everything here is invented: a fictional circuit, fictional teams and
drivers, and a simple point-mass lap simulation (power, drag, downforce,
grip, braking, and battery energy running out on long straights). The
numbers behave like the real thing so every view has something sensible
to show, but they are not real results.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.interpolate import splev, splprep

from .model import Driver, SessionData

DEMO_YEAR = 9999  # never collides with a real season
G = 9.81
RHO = 1.2
MASS = 800.0
DS = 5.0  # metres between simulation points


@dataclass
class TeamSpec:
    name: str
    color: str
    pu: str
    power_kw: float      # total, combustion + electric
    electric_kw: float   # part of it that runs out when energy is spent
    clip_m: float        # full-throttle metres before the battery runs dry
    cda: float           # drag area
    cla: float           # downforce area
    mech: float          # mechanical grip (slow corners, traction)
    deg: float           # tyre wear factor


TEAMS = [
    TeamSpec("Halcyon", "#00d2be", "Kestrel", 720, 350, 700, 1.06, 3.15, 1.62, 0.95),
    TeamSpec("Corsa Vermiglio", "#e8002d", "Vulcan", 716, 350, 560, 1.10, 3.20, 1.64, 1.00),
    TeamSpec("Tangerine Works", "#ff8000", "Kestrel", 718, 350, 640, 1.12, 3.22, 1.60, 0.92),
    TeamSpec("Meridian", "#3671c6", "Torque", 712, 350, 600, 1.04, 3.05, 1.61, 1.02),
    TeamSpec("Fernwood GP", "#229971", "Kaze", 700, 350, 420, 1.09, 3.00, 1.57, 1.05),
    TeamSpec("Bluewater", "#0093cc", "Kestrel", 718, 350, 640, 1.08, 2.92, 1.56, 1.04),
    TeamSpec("Granite", "#b6babd", "Vulcan", 712, 350, 540, 1.11, 2.95, 1.55, 1.08),
    TeamSpec("Meridian Academy", "#6692ff", "Torque", 710, 350, 580, 1.10, 2.97, 1.57, 1.03),
    TeamSpec("Northgate", "#00594f", "Kestrel", 716, 350, 630, 1.13, 2.88, 1.54, 1.06),
    TeamSpec("Vierkreis", "#52e252", "Ringwerk", 704, 350, 480, 1.12, 2.90, 1.55, 1.04),
    TeamSpec("Condor", "#c8a24a", "Vulcan", 710, 350, 540, 1.14, 2.86, 1.53, 1.07),
]

# (abbr, number, first, last, country, skill seconds per lap: negative = faster)
DRIVERS = [
    ("QUI", "7", "Tomas", "Quill", "POR", -0.12), ("MAR", "21", "Eli", "Marsh", "GBR", 0.10),
    ("DUV", "9", "Rafael", "Duval", "SUI", -0.05), ("KIR", "34", "Anton", "Kirsch", "AUT", 0.02),
    ("FEN", "2", "Jonah", "Fenwick", "IRL", -0.06), ("ORO", "70", "Kai", "Oroko", "KEN", 0.01),
    ("VEL", "3", "Mateo", "Velarde", "URU", -0.18), ("TAN", "19", "Ren", "Tanabe", "JPN", 0.22),
    ("IVE", "8", "Sami", "Iversen", "NOR", -0.02), ("BRU", "26", "Oskar", "Brun", "DEN", 0.30),
    ("CAS", "42", "Leo", "Castell", "AND", 0.00), ("DRA", "15", "Petra", "Dragan", "CRO", -0.03),
    ("WEB", "61", "Finn", "Weber", "GER", 0.08), ("NAI", "39", "Arjun", "Nair", "IND", 0.05),
    ("HOL", "50", "Theo", "Holm", "SWE", 0.06), ("PAZ", "17", "Diego", "Paz", "CHI", 0.12),
    ("ROM", "22", "Luca", "Romano", "ITA", 0.00), ("SKY", "36", "Noah", "Skye", "CAN", 0.14),
    ("LAN", "29", "Emil", "Lang", "BEL", 0.04), ("OKO", "58", "Ade", "Okoye", "NGA", 0.06),
    ("VAR", "64", "Juho", "Varis", "FIN", 0.10), ("REY", "92", "Iker", "Reyes", "COL", 0.12),
]
TEAM_OF = {d[0]: TEAMS[i // 2] for i, d in enumerate(DRIVERS)}

# A fictional 5.4 km circuit: long back straight, fast esses, slow hairpins.
TRACK_POINTS = [
    (0, 0), (350, 0), (700, 0), (900, 40), (960, 160), (900, 300), (820, 380),
    (860, 470), (980, 520), (1120, 500), (1260, 560), (1340, 700), (1300, 820),
    (1180, 880), (1080, 980), (1100, 1120), (1220, 1200), (1500, 1220),
    (1900, 1210), (2300, 1180), (2550, 1120), (2620, 1000), (2540, 900),
    (2380, 860), (2260, 760), (2280, 620), (2380, 520), (2420, 380),
    (2330, 250), (2120, 200), (1900, 180), (1700, 120), (1500, 60), (1200, 30),
    (900, -60), (600, -110), (300, -90), (60, -60),
]
TRACK_LENGTH = 5400.0


def _build_track(points=TRACK_POINTS, length=TRACK_LENGTH):
    pts = np.array(points + [points[0]], dtype=float)
    tck, _ = splprep([pts[:, 0], pts[:, 1]], s=len(pts) * 6, per=1)
    u = np.linspace(0, 1, 6000, endpoint=False)
    x, y = splev(u, tck)
    seg = np.hypot(np.diff(x, append=x[0]), np.diff(y, append=y[0]))
    scale = length / seg.sum()
    x, y = x * scale, y * scale
    # resample to an even spacing of DS metres
    seg = np.hypot(np.diff(x, append=x[0]), np.diff(y, append=y[0]))
    s = np.concatenate([[0], np.cumsum(seg)[:-1]])
    grid = np.arange(0, length, DS)
    x = np.interp(grid, s, x)
    y = np.interp(grid, s, y)
    dx, dy = np.gradient(x), np.gradient(y)
    ddx, ddy = np.gradient(dx), np.gradient(dy)
    kappa = np.abs(dx * ddy - dy * ddx) / np.power(dx * dx + dy * dy, 1.5)
    kappa = np.convolve(np.pad(kappa, 6, mode="wrap"), np.ones(13) / 13, "valid")
    # put the start/finish line on the main straight, as on a real circuit:
    # a third of the way down the longest run without a corner
    straight = kappa < 0.002
    best, run, best_end = 0, 0, 0
    for i in range(2 * len(kappa)):
        run = run + 1 if straight[i % len(kappa)] else 0
        if run > best:
            best, best_end = min(run, len(kappa)), i
    start = (best_end - best + best // 3) % len(kappa)
    x, y, kappa = np.roll(x, -start), np.roll(y, -start), np.roll(kappa, -start)
    return grid, x, y, kappa


def _simulate(team: TeamSpec, kappa: np.ndarray, grip: float = 1.0):
    """Point-mass lap: returns speed (m/s), throttle %, brake, clipping flag."""
    n = len(kappa)
    k_down = 0.5 * RHO * team.cla / MASS
    k_drag = 0.5 * RHO * team.cda / MASS
    mu = team.mech * grip
    # cornering limit
    denom = kappa - mu * k_down
    vcorner = np.where(denom > 1e-6, np.sqrt(mu * G / np.maximum(denom, 1e-6)), 120.0)
    vcorner = np.minimum(vcorner, 120.0)
    v = vcorner.copy()
    # two laps so the start/finish straight is continuous
    for _ in range(2):
        # forward pass: acceleration, with battery energy running out
        full_since = 0.0
        clip = np.zeros(n, dtype=bool)
        for i in range(n):
            j = (i + 1) % n
            vi = max(v[i], 5.0)
            p = team.power_kw * 1000
            if full_since > team.clip_m:
                p -= team.electric_kw * 1000 * 0.75
                clip[i] = True
            a_power = p / (MASS * vi) - k_drag * vi * vi
            a_grip = mu * (G + k_down * vi * vi)
            a = min(a_power, a_grip)
            vnext = math.sqrt(max(vi * vi + 2 * a * DS, 1.0))
            if vnext < v[j]:
                v[j] = vnext
                full_since += DS
            else:
                full_since = 0.0
        # backward pass: braking
        for i in range(n - 1, -1, -1):
            j = (i + 1) % n
            vj = v[j]
            decel = 1.9 * mu / 1.6 * (G + k_down * vj * vj) + k_drag * vj * vj
            vmax = math.sqrt(vj * vj + 2 * decel * DS)
            if v[i] > vmax:
                v[i] = vmax
    # inputs
    dv = np.roll(v, -1) - v
    braking = dv < -0.25
    at_limit = np.abs(v - vcorner) < 0.4
    throttle = np.where(braking, 0.0, np.where(at_limit, 45.0, 100.0))
    throttle = np.convolve(np.pad(throttle, 2, mode="wrap"), np.ones(5) / 5, "valid")
    # recompute clipping on the final profile
    full = throttle > 98
    clip = np.zeros(n, dtype=bool)
    run = 0.0
    for i in range(n):
        run = run + DS if full[i] else 0.0
        clip[i] = run > team.clip_m
    return v, throttle, braking, clip


def _gear_rpm(speed_kmh: np.ndarray):
    tops = np.array([95, 130, 165, 200, 240, 275, 310, 360], dtype=float)
    gear = np.searchsorted(tops, speed_kmh) + 1
    gear = np.clip(gear, 1, 8)
    lo = np.concatenate([[0], tops[:-1]])[gear - 1]
    hi = tops[gear - 1]
    rpm = 7600 + (speed_kmh - lo) / (hi - lo) * 4200
    return gear, np.clip(rpm, 4000, 11800)


class _Profile:
    """A team/driver's reference lap on the demo track."""

    def __init__(self, team: TeamSpec, skill: float, track, grip=1.0):
        grid, x, y, kappa = track
        v, thr, brk, clip = _simulate(team, kappa, grip)
        dt = DS / np.maximum(v, 1.0)
        t = np.concatenate([[0], np.cumsum(dt)[:-1]])
        self.base_time = float(dt.sum()) + skill
        self.dist = grid
        self.x, self.y = x, y
        self.speed = v * 3.6
        self.throttle = thr
        self.brake = brk
        self.clip = clip
        self.time = t * (self.base_time / float(dt.sum()))
        self.gear, self.rpm = _gear_rpm(self.speed)
        # active aero open (reported in the DRS channel) on straights
        self.drs = np.where(thr > 98, 12, 0)

    def lap(self, lap_time: float, rng: np.random.Generator) -> pd.DataFrame:
        f = self.base_time / lap_time
        idx = np.arange(0, len(self.dist), 9)  # ~45 m apart like real car data
        noise = rng.normal(0, 0.6, len(idx))
        speed = self.speed[idx] * f + noise
        return pd.DataFrame({
            "Distance": self.dist[idx],
            "Time": self.time[idx] / f,
            "X": self.x[idx] * 10, "Y": self.y[idx] * 10, "Z": np.zeros(len(idx)),
            "Speed": speed,
            "Throttle": np.clip(self.throttle[idx] + rng.normal(0, 1, len(idx)), 0, 100),
            "Brake": self.brake[idx],
            "nGear": self.gear[idx],
            "RPM": self.rpm[idx] * f,
            "DRS": self.drs[idx],
        })


_TRACK = None
_PROFILES: dict = {}


def _track():
    global _TRACK
    if _TRACK is None:
        _TRACK = _build_track()
    return _TRACK


def _profile(abbr: str) -> _Profile:
    if abbr not in _PROFILES:
        skill = next(d[5] for d in DRIVERS if d[0] == abbr)
        _PROFILES[abbr] = _Profile(TEAM_OF[abbr], skill, _track())
    return _PROFILES[abbr]


def _corners(track) -> list[dict]:
    grid, x, y, kappa = track
    out = []
    n = len(kappa)
    for i in range(n):
        if kappa[i] < 0.004:
            continue
        window = kappa[[(i + k) % n for k in range(-24, 25)]]
        if kappa[i] < window.max():
            continue
        if out and grid[i] - out[-1]["distance"] < 120:
            continue
        out.append({"distance": float(grid[i]), "x": float(x[i] * 10), "y": float(y[i] * 10)})
    for k, c in enumerate(out, 1):
        c.update(number=k, letter="", angle=0.0)
    return out


SCHEDULE = [
    {"round": 1, "name": "Demo Grand Prix", "location": "Demo Park", "country": "Nowhere",
     "date": "2026-10-25", "format": "conventional",
     "sessions": [{"name": n, "date": None}
                  for n in ("Practice 1", "Practice 2", "Practice 3", "Qualifying", "Race")]},
]


def schedule() -> list[dict]:
    return SCHEDULE


def _drivers() -> list[Driver]:
    return [Driver(number=n, abbr=a, name=f"{f} {l}", team=TEAM_OF[a].name,
                   color=TEAM_OF[a].color, country=c)
            for a, n, f, l, c, _ in DRIVERS]


def _weather(duration_s: float, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    t = np.arange(0, duration_s, 60.0)
    return pd.DataFrame({
        "Time": pd.to_timedelta(t, unit="s"),
        "AirTemp": 24 + np.cumsum(rng.normal(0, 0.05, len(t))),
        "TrackTemp": 38 + np.cumsum(rng.normal(-0.03, 0.12, len(t))),
        "Humidity": 48 + np.cumsum(rng.normal(0, 0.1, len(t))),
        "Pressure": 1012 + rng.normal(0, 0.2, len(t)),
        "Rainfall": np.zeros(len(t), dtype=bool),
        "WindSpeed": np.abs(2.5 + np.cumsum(rng.normal(0, 0.1, len(t)))),
        "WindDirection": (200 + np.cumsum(rng.normal(0, 3, len(t)))) % 360,
    })


def _sectors(prof: _Profile, lap_time: float):
    f = prof.base_time / lap_time
    total = prof.time[-1] / f + (DS / max(prof.speed[-1] / 3.6, 1))
    t1 = np.interp(TRACK_LENGTH / 3, prof.dist, prof.time) / f
    t2 = np.interp(2 * TRACK_LENGTH / 3, prof.dist, prof.time) / f
    scale = lap_time / total
    return t1 * scale, (t2 - t1) * scale, lap_time - t2 * scale


def _traps(prof: _Profile, lap_time: float, rng):
    f = prof.base_time / lap_time
    def at(d):
        return float(np.interp(d, prof.dist, prof.speed)) * f + rng.normal(0, 0.8)
    st = float(prof.speed.max()) * f + rng.normal(0, 0.8)
    return at(1600), at(3700), at(5350), st


def _lap_row(abbr, number, lap_no, lap_time, start, stint, compound, life, rng, **extra):
    prof = _profile(abbr)
    s1, s2, s3 = _sectors(prof, lap_time) if lap_time else (None, None, None)
    i1, i2, fl, st = _traps(prof, lap_time or prof.base_time, rng)
    row = {
        "Driver": abbr, "DriverNumber": number, "Team": TEAM_OF[abbr].name,
        "LapNumber": float(lap_no),
        "LapTime": pd.Timedelta(seconds=lap_time) if lap_time else pd.NaT,
        "Sector1Time": pd.Timedelta(seconds=s1) if s1 else pd.NaT,
        "Sector2Time": pd.Timedelta(seconds=s2) if s2 else pd.NaT,
        "Sector3Time": pd.Timedelta(seconds=s3) if s3 else pd.NaT,
        "LapStartTime": pd.Timedelta(seconds=start),
        "Time": pd.Timedelta(seconds=start + (lap_time or prof.base_time)),
        "Stint": float(stint), "Compound": compound, "TyreLife": float(life),
        "FreshTyre": life <= 1, "PitInTime": pd.NaT, "PitOutTime": pd.NaT,
        "SpeedI1": i1, "SpeedI2": i2, "SpeedFL": fl, "SpeedST": st,
        "TrackStatus": "1", "Position": np.nan, "IsAccurate": True,
        "Deleted": False, "DeletedReason": "", "IsPersonalBest": False,
    }
    row.update(extra)
    return row


COMPOUND_PACE = {"SOFT": -0.55, "MEDIUM": 0.0, "HARD": 0.45}
COMPOUND_DEG = {"SOFT": 0.085, "MEDIUM": 0.05, "HARD": 0.03}


def _race(seed=7) -> SessionData:
    rng = np.random.default_rng(seed)
    total = 56
    sc_laps = range(21, 25)
    rows = []
    cum = {}
    strategies = {}
    for i, (abbr, number, *_rest) in enumerate(DRIVERS):
        one_stop = rng.random() < 0.6
        if one_stop:
            pit = int(rng.integers(18, 30))
            strategies[abbr] = [("MEDIUM", 1, pit), ("HARD", pit + 1, total)]
        else:
            p1, p2 = int(rng.integers(12, 18)), int(rng.integers(34, 42))
            strategies[abbr] = [("SOFT", 1, p1), ("HARD", p1 + 1, p2), ("MEDIUM", p2 + 1, total)]
        cum[abbr] = 0.6 * i  # grid gaps on lap 1
    order_start = [d[0] for d in DRIVERS]
    for lap in range(1, total + 1):
        lap_times = {}
        for abbr, number, *_rest in DRIVERS:
            prof = _profile(abbr)
            team = TEAM_OF[abbr]
            stint_no, (comp, s_from, s_to) = next(
                (k, s) for k, s in enumerate(strategies[abbr], 1) if s[1] <= lap <= s[2])
            life = lap - s_from + 1
            fuel = 0.055 * (total - lap)
            t = (prof.base_time + 3.2 + fuel + COMPOUND_PACE[comp]
                 + COMPOUND_DEG[comp] * team.deg * life + rng.normal(0, 0.18))
            if lap == 1:
                t += 6 + 0.25 * order_start.index(abbr)
            if lap in sc_laps:
                t = prof.base_time * 1.45 + rng.normal(0, 0.3)
            extra = {}
            if lap == s_to and lap != total:
                t += 21.0
                extra["PitInTime"] = pd.Timedelta(seconds=cum[abbr] + t - 1)
            if lap == s_from and stint_no > 1:
                t += 2.0
                extra["PitOutTime"] = pd.Timedelta(seconds=cum[abbr] + 1)
            if lap in sc_laps:
                extra["TrackStatus"] = "4"
                extra["IsAccurate"] = False
            if lap == 1 or extra.get("PitInTime") is not None or extra.get("PitOutTime") is not None:
                extra["IsAccurate"] = False
            lap_times[abbr] = (t, stint_no, comp, life, extra)
        # safety car bunches the field up
        if lap == sc_laps[-1]:
            order = sorted(cum, key=cum.get)
            leader = cum[order[0]]
            for k, abbr in enumerate(order):
                cum[abbr] = leader + 0.9 * k - lap_times[abbr][0] + lap_times[order[0]][0]
        for abbr, number, *_rest in DRIVERS:
            t, stint_no, comp, life, extra = lap_times[abbr]
            rows.append(_lap_row(abbr, number, lap, t, cum[abbr], stint_no, comp, life, rng, **extra))
            cum[abbr] += t
        order = sorted(cum, key=cum.get)
        for r in rows[-len(DRIVERS):]:
            r["Position"] = float(order.index(r["Driver"]) + 1)
    laps = pd.DataFrame(rows)
    final = sorted(cum, key=cum.get)
    winner_time = cum[final[0]]
    points = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
    res = pd.DataFrame([{
        "Abbreviation": a, "DriverNumber": next(d[1] for d in DRIVERS if d[0] == a),
        "TeamName": TEAM_OF[a].name, "Position": float(k + 1),
        "ClassifiedPosition": str(k + 1),
        "GridPosition": float(order_start.index(a) + 1),
        "Time": pd.Timedelta(seconds=(cum[a] - winner_time) if k else winner_time),
        "Status": "Finished", "Points": float(points[k]) if k < 10 else 0.0,
        "Laps": float(total),
    } for k, a in enumerate(final)])
    return _session("Race", "R", laps, res, winner_time + 600, seed, race_control=[
        {"time": None, "lap": 1, "category": "Flag", "message": "GREEN LIGHT - PIT EXIT OPEN"},
        {"time": None, "lap": 21, "category": "SafetyCar", "message": "SAFETY CAR DEPLOYED"},
        {"time": None, "lap": 24, "category": "SafetyCar", "message": "SAFETY CAR IN THIS LAP"},
        {"time": None, "lap": 33, "category": "Other",
         "message": "CAR 26 (BRU) TIME 1:41.882 DELETED - TRACK LIMITS AT TURN 9"},
        {"time": None, "lap": 56, "category": "Flag", "message": "CHEQUERED FLAG"},
    ], track_status=[
        {"lap": 21, "status": "4", "message": "SCStarted"},
        {"lap": 25, "status": "1", "message": "AllClear"},
    ])


def _qualifying(seed=11) -> SessionData:
    rng = np.random.default_rng(seed)
    rows = []
    best = {}
    clock = 0.0
    remaining = [d[0] for d in DRIVERS]
    q_times = {a: {} for a in remaining}
    for part, (keep, length) in enumerate([(16, 18 * 60), (10, 15 * 60), (0, 12 * 60)], 1):
        part_best = {}
        for abbr in remaining:
            number = next(d[1] for d in DRIVERS if d[0] == abbr)
            prof = _profile(abbr)
            lap_no = len([r for r in rows if r["Driver"] == abbr])
            t0 = clock + rng.uniform(60, 240)
            runs = 2 if part < 3 else 2
            for run in range(runs):
                lap_no += 1
                rows.append(_lap_row(abbr, number, lap_no, None, t0, run + 1, "SOFT", 1, rng,
                                     IsAccurate=False))
                t0 += prof.base_time * 1.3
                lap_no += 1
                t = prof.base_time + 0.25 - 0.12 * part - 0.1 * run + abs(rng.normal(0, 0.12))
                deleted = rng.random() < 0.04
                rows.append(_lap_row(abbr, number, lap_no, t, t0, run + 1, "SOFT", 2, rng,
                                     Deleted=deleted,
                                     DeletedReason="TRACK LIMITS AT TURN 9" if deleted else ""))
                if not deleted:
                    part_best[abbr] = min(part_best.get(abbr, 99e9), t)
                t0 += t
                lap_no += 1
                rows.append(_lap_row(abbr, number, lap_no, None, t0, run + 1, "SOFT", 3, rng,
                                     IsAccurate=False))
                t0 += prof.base_time * 1.4 + rng.uniform(120, 300)
        for a, t in part_best.items():
            q_times[a][f"Q{part}"] = t
            best[a] = min(best.get(a, 99e9), t)
        clock += length + 8 * 60
        ranked = sorted(remaining, key=lambda a: part_best.get(a, 99e9))
        remaining = ranked[:keep] if keep else ranked
    laps = pd.DataFrame(rows)

    def rank_key(a):
        for q in ("Q3", "Q2", "Q1"):
            if q in q_times[a]:
                return ({"Q3": 0, "Q2": 1, "Q1": 2}[q], q_times[a][q])
        return (3, 0)
    order = sorted(q_times, key=rank_key)
    res = pd.DataFrame([{
        "Abbreviation": a, "DriverNumber": next(d[1] for d in DRIVERS if d[0] == a),
        "TeamName": TEAM_OF[a].name, "Position": float(k + 1), "ClassifiedPosition": str(k + 1),
        **{q: pd.Timedelta(seconds=q_times[a][q]) if q in q_times[a] else pd.NaT
           for q in ("Q1", "Q2", "Q3")},
        "Status": "", "Points": np.nan,
    } for k, a in enumerate(order)])
    return _session("Qualifying", "Q", laps, res, clock, seed, race_control=[
        {"time": None, "lap": None, "category": "Flag", "message": "GREEN LIGHT - PIT EXIT OPEN"},
        {"time": None, "lap": None, "category": "Other",
         "message": "TRACK LIMITS - LAP TIMES DELETED AT TURN 9 ARE UNDER REVIEW"},
    ])


def _practice(name: str, seed: int) -> SessionData:
    rng = np.random.default_rng(seed)
    rows = []
    for abbr, number, *_rest in DRIVERS:
        prof = _profile(abbr)
        clock = rng.uniform(0, 600)
        lap_no = 0
        for run in range(6):
            comp = ["MEDIUM", "HARD", "SOFT", "MEDIUM", "MEDIUM", "HARD"][run]
            for k in range(int(rng.integers(3, 9))):
                lap_no += 1
                if k == 0:
                    rows.append(_lap_row(abbr, number, lap_no, None, clock, run + 1, comp, 1, rng,
                                         IsAccurate=False))
                    clock += prof.base_time * 1.3
                    continue
                fuel = 0.6 if run >= 3 else 0.0
                t = (prof.base_time + 1.2 + fuel + COMPOUND_PACE[comp]
                     + COMPOUND_DEG[comp] * k + abs(rng.normal(0, 0.3)))
                rows.append(_lap_row(abbr, number, lap_no, t, clock, run + 1, comp, k + 1, rng))
                clock += t
            clock += rng.uniform(300, 900)
    laps = pd.DataFrame(rows)
    best = laps.groupby("Driver")["LapTime"].min().sort_values()
    res = pd.DataFrame([{"Abbreviation": a, "TeamName": TEAM_OF[a].name,
                         "Position": float(k + 1), "ClassifiedPosition": str(k + 1),
                         "Time": t, "Status": "", "Points": np.nan}
                        for k, (a, t) in enumerate(best.items())])
    return _session(name, "FP", laps, res, 3600, seed)


def _session(name, kind, laps, results, duration, seed, race_control=(), track_status=()):
    track = _track()

    def telemetry(abbr: str, lap: int):
        row = laps[(laps["Driver"] == abbr) & (laps["LapNumber"] == lap)]
        if row.empty:
            return None
        lt = row.iloc[0]["LapTime"]
        lap_time = lt.total_seconds() if pd.notna(lt) else _profile(abbr).base_time * 1.3
        rng = np.random.default_rng(hash((abbr, lap, seed)) % 2**32)
        return _profile(abbr).lap(lap_time, rng)

    meta = {"year": DEMO_YEAR, "round": 1, "event": "Demo Grand Prix", "session": name,
            "type": kind, "date": "2026-10-25", "circuit": "Demo Park", "country": "Nowhere",
            "demo": True, "length_m": TRACK_LENGTH}
    return SessionData(
        meta=meta, drivers=_drivers(), laps=laps, results=results, telemetry=telemetry,
        corners=_corners(track), rotation=0.0, weather=_weather(duration, seed),
        race_control=list(race_control), track_status=list(track_status),
        power_units={t.name: t.pu for t in TEAMS},
    )


def load(session: str) -> SessionData:
    s = session.lower()
    if s in ("race", "r"):
        return _race()
    if s in ("qualifying", "q"):
        return _qualifying()
    if s.startswith("practice") or s.startswith("fp"):
        n = int(s[-1]) if s[-1].isdigit() else 1
        return _practice(f"Practice {n}", 20 + n)
    raise ValueError(f"demo has no session {session!r}")


# -- season view: a few more invented tracks ---------------------------------

DEMO_SEASON_TRACKS = [
    ("Demo Grand Prix", 1.00, 1.0),
    ("Harbour Street Circuit", 0.80, 1.25),
    ("High Plains Speedway", 1.10, 0.70),
    ("Lakeside Ring", 0.95, 1.05),
    ("Desert Dunes", 1.05, 0.85),
    ("Old Forest Circuit", 0.90, 1.15),
]


def season() -> list[dict]:
    """Each team's best qualifying pace per invented round, % off the best."""
    base = _track()
    grid, x, y, kappa = base
    out = []
    for rnd, (name, scale, twist) in enumerate(DEMO_SEASON_TRACKS, 1):
        k = kappa * twist / scale
        best = {}
        for team in TEAMS:
            v, *_ = _simulate(team, k)
            best[team.name] = float((DS / np.maximum(v, 1)).sum()) * scale
        top = min(best.values())
        out.append({"round": rnd, "event": name,
                    "teams": {t: round((b / top - 1) * 100, 3) for t, b in best.items()}})
    return out
