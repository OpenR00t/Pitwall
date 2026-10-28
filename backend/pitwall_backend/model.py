# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""The session data every analysis works on.

Both data sources (FastF1 and the built-in demo) produce a `SessionData`.
Lap and telemetry tables use FastF1's column names and types, so the
analyses don't care where the data came from.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd

# Telemetry channels the app understands, in display order.
CHANNELS = ["Speed", "Throttle", "Brake", "nGear", "RPM", "DRS"]


@dataclass
class Driver:
    number: str
    abbr: str
    name: str
    team: str
    color: str  # "#rrggbb"
    country: str = ""
    headshot: str = ""

    def to_json(self) -> dict:
        return {
            "number": self.number, "abbr": self.abbr, "name": self.name,
            "team": self.team, "color": self.color, "country": self.country,
            "headshot": self.headshot,
        }


@dataclass
class SessionData:
    """One loaded session.

    laps:      FastF1-style Laps table (one row per lap per driver).
    results:   FastF1-style results table.
    telemetry: callable (driver abbr, lap number) -> telemetry DataFrame
               with Distance (m), Time (s from lap start), X, Y and the
               CHANNELS columns; None when the lap has no telemetry.
    """
    meta: dict
    drivers: list[Driver]
    laps: pd.DataFrame
    results: pd.DataFrame
    telemetry: Callable[[str, int], pd.DataFrame | None]
    corners: list[dict] = field(default_factory=list)  # number, letter, distance, x, y, angle
    rotation: float = 0.0  # degrees to rotate the map so it matches the official one
    weather: pd.DataFrame | None = None
    race_control: list[dict] = field(default_factory=list)
    track_status: list[dict] = field(default_factory=list)
    power_units: dict[str, str] = field(default_factory=dict)  # team -> PU maker
    _tel_cache: dict = field(default_factory=dict, repr=False)

    # -- convenience -----------------------------------------------------

    def driver(self, abbr: str) -> Driver | None:
        return next((d for d in self.drivers if d.abbr == abbr), None)

    @property
    def is_race(self) -> bool:
        return self.meta.get("type") in ("R", "S")

    def lap_telemetry(self, abbr: str, lap: int) -> pd.DataFrame | None:
        key = (abbr, int(lap))
        if key not in self._tel_cache:
            if len(self._tel_cache) > 400:
                self._tel_cache.clear()
            self._tel_cache[key] = self.telemetry(abbr, int(lap))
        return self._tel_cache[key]

    def driver_laps(self, abbr: str) -> pd.DataFrame:
        return self.laps[self.laps["Driver"] == abbr].sort_values("LapNumber")

    def fastest_lap(self, abbr: str) -> pd.Series | None:
        laps = self.driver_laps(abbr)
        laps = laps[laps["LapTime"].notna()]
        if "Deleted" in laps:
            laps = laps[laps["Deleted"] != True]  # noqa: E712 - may hold None
        if laps.empty:
            return None
        return laps.loc[laps["LapTime"].idxmin()]

    def fastest_lap_number(self, abbr: str) -> int | None:
        lap = self.fastest_lap(abbr)
        return None if lap is None else int(lap["LapNumber"])

    def classified_order(self) -> list[str]:
        """Driver abbreviations in finishing / classification order."""
        order = []
        if not self.results.empty and "Abbreviation" in self.results:
            res = self.results.sort_values("Position", na_position="last")
            order = [a for a in res["Abbreviation"] if isinstance(a, str)]
        for d in self.drivers:
            if d.abbr not in order:
                order.append(d.abbr)
        return order


# -- JSON helpers -------------------------------------------------------------


def secs(value) -> float | None:
    """Timedelta / number -> seconds (rounded), NaN/NaT -> None."""
    if value is None:
        return None
    if isinstance(value, (pd.Timedelta, np.timedelta64)):
        if pd.isna(value):
            return None
        return round(pd.Timedelta(value).total_seconds(), 3)
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else round(f, 3)


def num(value, digits: int = 2):
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, digits)


def arr(values, digits: int = 2) -> list:
    """Array-like of numbers -> JSON list, NaN -> null."""
    a = np.asarray(values, dtype="float64")
    out = np.round(a, digits).tolist()
    return [None if (isinstance(v, float) and math.isnan(v)) else v for v in out]


def text(value) -> str | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if value is pd.NaT:
        return None
    s = str(value)
    return s if s and s != "nan" else None
