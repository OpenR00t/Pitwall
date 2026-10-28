# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Which power unit each team uses, by season.

Matched by a case-insensitive substring of the team name, so sponsor
changes ("Visa Cash App RB", "Racing Bulls") don't matter. Unknown teams
get no family and are left out of the power-unit view.
"""

from __future__ import annotations

# (first season, last season or None) -> [(team substring, PU maker)]
POWER_UNITS: list[tuple[int, int | None, list[tuple[str, str]]]] = [
    (2026, None, [
        ("mercedes", "Mercedes"), ("mclaren", "Mercedes"),
        ("williams", "Mercedes"), ("alpine", "Mercedes"),
        ("ferrari", "Ferrari"), ("haas", "Ferrari"), ("cadillac", "Ferrari"),
        ("red bull", "Red Bull Ford"), ("racing bulls", "Red Bull Ford"),
        ("aston martin", "Honda"),
        ("audi", "Audi"), ("sauber", "Audi"),
    ]),
    (2022, 2025, [
        ("mercedes", "Mercedes"), ("mclaren", "Mercedes"),
        ("williams", "Mercedes"), ("aston martin", "Mercedes"),
        ("ferrari", "Ferrari"), ("haas", "Ferrari"), ("sauber", "Ferrari"),
        ("alfa romeo", "Ferrari"),
        ("red bull", "Honda RBPT"), ("racing bulls", "Honda RBPT"),
        ("alphatauri", "Honda RBPT"), ("rb", "Honda RBPT"),
        ("alpine", "Renault"),
    ]),
]


def power_unit(team: str, year: int) -> str | None:
    name = (team or "").lower()
    for first, last, table in POWER_UNITS:
        if year >= first and (last is None or year <= last):
            for key, maker in table:
                # "rb" alone would match too much; require a whole word
                if key == "rb":
                    if name.split()[:1] == ["rb"]:
                        return maker
                elif key in name:
                    return maker
    return None


COMPOUND_ORDER = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET",
                  "HYPERSOFT", "ULTRASOFT", "SUPERSOFT", "UNKNOWN", "TEST_UNKNOWN"]
