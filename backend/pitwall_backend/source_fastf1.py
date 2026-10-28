# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Loading real sessions with FastF1, and the F1 TV sign-in it needs.

F1's live timing service, which FastF1 reads, needs an F1 TV account. The
password goes straight to F1's sign-in through FastF1; only the session
token FastF1 receives is kept (in FastF1's own data folder).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd
import platformdirs

import fastf1
from fastf1.exceptions import F1AuthError
from fastf1.internals.f1account import clear_token, token_manager
from fastf1.internals.f1account.login import login

from .model import Driver, SessionData, text
from .teams import power_unit

log = logging.getLogger("pitwall")

CACHE_DIR = Path(platformdirs.user_cache_dir("pitwall", appauthor=False))
SEASON_DIR = CACHE_DIR / "season"


class AuthRequired(Exception):
    pass


def enable_cache():
    (CACHE_DIR / "fastf1").mkdir(parents=True, exist_ok=True)
    if hasattr(fastf1.Cache, "configure"):
        fastf1.Cache.configure(cache_dir=str(CACHE_DIR / "fastf1"))
    else:
        fastf1.Cache.enable_cache(str(CACHE_DIR / "fastf1"))
    # never fall back to prompting on a terminal nobody can see
    token_manager._default_auth_func = _no_interactive_sign_in


def _no_interactive_sign_in():
    raise F1AuthError("Not signed in to F1 TV.")


# -- sign-in -----------------------------------------------------------------------


def auth_status() -> dict:
    token = token_manager.get_stored()
    if token is None:
        return {"signed_in": False}
    claims = token.claims
    return {
        "signed_in": token.is_valid(),
        "expired": not token.is_valid(),
        "expires": dt.datetime.fromtimestamp(token.expires_at).isoformat(timespec="minutes"),
        "product": claims.get("SubscribedProduct"),
        "status": claims.get("SubscriptionStatus"),
    }


def sign_in(username: str, password: str) -> dict:
    token_manager.get(force_renew=True, auth_func=lambda: login(username, password))
    return auth_status()


def sign_out() -> dict:
    clear_token()
    return auth_status()


def _require_auth():
    token = token_manager.get_stored()
    if token is None or not token.is_valid():
        raise AuthRequired("Sign in with your F1 TV account to load sessions.")


# -- schedule --------------------------------------------------------------------


def schedule(year: int) -> list[dict]:
    sch = fastf1.get_event_schedule(year, include_testing=False)
    out = []
    for _, e in sch.iterrows():
        sessions = []
        for k in range(1, 6):
            name = text(e.get(f"Session{k}"))
            if not name or name == "None":
                continue
            date = e.get(f"Session{k}DateUtc")
            sessions.append({"name": name,
                             "date": None if pd.isna(date) else pd.Timestamp(date).isoformat()})
        out.append({
            "round": int(e["RoundNumber"]), "name": text(e["EventName"]),
            "location": text(e.get("Location")), "country": text(e.get("Country")),
            "date": None if pd.isna(e.get("EventDate")) else pd.Timestamp(e["EventDate"]).date().isoformat(),
            "format": text(e.get("EventFormat")), "sessions": sessions,
        })
    return out


# -- loading ---------------------------------------------------------------------


class _ProgressHandler(logging.Handler):
    def __init__(self, report: Callable[[str], None]):
        super().__init__(logging.INFO)
        self.report = report

    def emit(self, record):
        msg = record.getMessage()
        if record.levelno >= logging.INFO and len(msg) < 160:
            self.report(msg)


def _telemetry_fn(session):
    def get(abbr: str, lap: int):
        laps = session.laps.pick_drivers(abbr).pick_laps(lap)
        if laps.empty:
            return None
        try:
            tel = laps.iloc[0].get_telemetry()
        except Exception:  # missing car or position data for this lap
            return None
        if tel is None or tel.empty:
            return None
        out = pd.DataFrame({
            "Distance": tel["Distance"].to_numpy(float),
            "Time": tel["Time"].dt.total_seconds().to_numpy(float),
            "X": tel["X"].to_numpy(float), "Y": tel["Y"].to_numpy(float),
            "Z": tel["Z"].to_numpy(float) if "Z" in tel else np.zeros(len(tel)),
        })
        for c in ("Speed", "Throttle", "RPM"):
            out[c] = tel[c].to_numpy(float)
        out["Brake"] = tel["Brake"].astype(float).to_numpy()
        out["nGear"] = tel["nGear"].to_numpy(float)
        # the timing feed reports DRS as status codes: 10, 12 and 14 mean the
        # flap is open (8 is "eligible", lower is closed); keep just open/closed
        out["DRS"] = (tel["DRS"].to_numpy(float) >= 10).astype(float) if "DRS" in tel else 0.0
        return out
    return get


def load(year: int, round_: int, session_name: str,
         report: Callable[[str], None] = lambda m: None) -> SessionData:
    _require_auth()
    handler = _ProgressHandler(report)
    log = logging.getLogger("fastf1")
    log.addHandler(handler)
    try:
        report("Finding session")
        s = fastf1.get_session(year, round_, session_name)
        s.load(laps=True, telemetry=True, weather=True, messages=True)
        try:
            laps = s.laps
        except Exception as exc:
            raise RuntimeError("F1 returned no timing data for this session "
                               "(it may not have run yet).") from exc
    finally:
        log.removeHandler(handler)

    res = s.results
    drivers = []
    for _, r in res.iterrows():
        color = text(r.get("TeamColor")) or "928374"
        drivers.append(Driver(
            number=str(r.get("DriverNumber")), abbr=text(r.get("Abbreviation")) or "?",
            name=text(r.get("FullName")) or text(r.get("BroadcastName")) or "",
            team=text(r.get("TeamName")) or "", color="#" + color.lstrip("#"),
            country=text(r.get("CountryCode")) or "", headshot=text(r.get("HeadshotUrl")) or ""))

    corners, rotation, corners_estimated = [], 0.0, False
    try:
        ci = s.get_circuit_info()
        rotation = float(ci.rotation)
        for _, c in ci.corners.iterrows():
            corners.append({"number": int(c["Number"]), "letter": text(c.get("Letter")) or "",
                            "distance": float(c["Distance"]), "x": float(c["X"]),
                            "y": float(c["Y"]), "angle": float(c.get("Angle", 0))})
    except Exception as exc:
        log.info("no circuit info for this session (%s); estimating corners", exc)
    if not corners:
        # new or changed layouts have no published corner map: find the
        # corners from where the session's fastest lap slows down
        try:
            corners = _estimate_corners(s.laps.pick_fastest().get_telemetry())
            corners_estimated = bool(corners)
        except Exception as exc:
            log.info("could not estimate corners: %s", exc)

    def messages():
        try:
            rc = s.race_control_messages
        except Exception:
            return []
        return [{"time": pd.Timestamp(m["Time"]).isoformat() if pd.notna(m.get("Time")) else None,
                 "lap": None if pd.isna(m.get("Lap")) else int(m["Lap"]),
                 "category": text(m.get("Category")), "message": text(m.get("Message")),
                 "flag": text(m.get("Flag"))} for _, m in rc.iterrows()]

    def status():
        try:
            ts = s.track_status
        except Exception:
            return []
        return [{"time": round(pd.Timedelta(t["Time"]).total_seconds(), 1),
                 "status": text(t.get("Status")), "message": text(t.get("Message"))}
                for _, t in ts.iterrows()]

    try:
        weather = s.weather_data
    except Exception:
        weather = None

    meta = {"year": year, "round": int(s.event["RoundNumber"]), "event": s.event["EventName"],
            "session": s.name, "type": _session_type(s.name),
            "date": pd.Timestamp(s.date).isoformat() if pd.notna(s.date) else None,
            "circuit": text(s.event.get("Location")), "country": text(s.event.get("Country")),
            "demo": False, "corners_estimated": corners_estimated}
    pus = {d.team: pu for d in drivers if (pu := power_unit(d.team, year))}
    return SessionData(meta=meta, drivers=drivers, laps=pd.DataFrame(laps), results=pd.DataFrame(res),
                       telemetry=_telemetry_fn(s), corners=corners, rotation=rotation,
                       weather=weather, race_control=messages(), track_status=status(),
                       power_units=pus)


def _estimate_corners(tel: pd.DataFrame) -> list[dict]:
    """Corners as the braking points of one lap: local speed minima at least
    12 km/h below the speed either side and 120 m apart, numbered in order."""
    from scipy.signal import find_peaks

    d = tel["Distance"].to_numpy(float)
    v = tel["Speed"].to_numpy(float)
    grid = np.arange(0.0, d[-1], 5.0)
    vg = np.interp(grid, d, v)
    vg = np.convolve(vg, np.ones(5) / 5, mode="same")   # 25 m smoothing
    idx, _ = find_peaks(-vg, prominence=12, distance=24)
    xs = np.interp(grid[idx], d, tel["X"].to_numpy(float))
    ys = np.interp(grid[idx], d, tel["Y"].to_numpy(float))
    return [{"number": k + 1, "letter": "", "distance": float(grid[i]), "x": float(x),
             "y": float(y), "angle": 0.0} for k, (i, x, y) in enumerate(zip(idx, xs, ys))]


def _session_type(name: str) -> str:
    return {"Race": "R", "Sprint": "S", "Qualifying": "Q", "Sprint Qualifying": "SQ",
            "Sprint Shootout": "SQ"}.get(name, "FP")


# -- season pace -------------------------------------------------------------------


SEASON_FORMAT = 2   # bump when the calculation changes; older stores are rebuilt


def quali_gaps(laps: pd.DataFrame) -> dict[str, float]:
    """Each team's best valid lap as % off the quickest team. Deleted laps
    (track limits) don't count."""
    ok = laps["LapTime"].notna()
    if "Deleted" in laps:
        ok &= ~laps["Deleted"].fillna(False).astype(bool)
    best = laps[ok].groupby("Team")["LapTime"].min()
    if best.empty:
        return {}
    top = best.min()
    return {t: round((v / top - 1) * 100, 3) for t, v in best.items()}


def season(year: int, report: Callable[[str], None] = lambda m: None) -> list[dict]:
    """Each team's best qualifying lap per round, % off the best team.

    Only timing (no telemetry) is loaded, and finished rounds are stored on
    disk, so after the first run only new rounds are fetched.
    """
    _require_auth()
    SEASON_DIR.mkdir(parents=True, exist_ok=True)
    store = SEASON_DIR / f"{year}.json"
    saved = json.loads(store.read_text()) if store.exists() else {}
    # rounds stored by an older calculation are rebuilt rather than trusted
    done = saved.get("rounds", {}) if saved.get("version") == SEASON_FORMAT else {}
    now = pd.Timestamp.now(tz="UTC")
    out = []
    for ev in schedule(year):
        quali = next((s for s in ev["sessions"] if s["name"] == "Qualifying"), None)
        if not quali or not quali["date"]:
            continue
        qdate = pd.Timestamp(quali["date"])
        if qdate.tzinfo is None:
            qdate = qdate.tz_localize("UTC")
        if qdate + pd.Timedelta(hours=3) > now:
            continue
        key = str(ev["round"])
        if key not in done:
            report(f"Round {ev['round']}: {ev['name']}")
            try:
                s = fastf1.get_session(year, ev["round"], "Qualifying")
                # race control messages are what mark laps deleted for track limits
                s.load(laps=True, telemetry=False, weather=False, messages=True)
                done[key] = {"round": ev["round"], "event": ev["name"], "teams": quali_gaps(s.laps)}
                store.write_text(json.dumps({"version": SEASON_FORMAT, "rounds": done}))
            except Exception as exc:  # keep going; show what we have
                report(f"Round {ev['round']} failed: {exc}")
                continue
        out.append(done[key])
    return out
