# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Every analysis on every demo session: nothing raises, and the results hold
together. Needs no F1 data or sign-in."""

import json
import unittest

from pitwall_backend import analysis, demo

SESSIONS = ["Practice 1", "Practice 2", "Practice 3", "Qualifying", "Race"]


def run_all(sd):
    order = sd.classified_order()
    out = {
        "overview": analysis.overview(sd),
        "laps": analysis.laps(sd),
        "telemetry": analysis.telemetry(sd, order[0], "fastest"),
        "compare": analysis.compare(sd, [(order[0], "fastest"), (order[1], "fastest")]),
        "track_map": analysis.track_map(sd, order[0], "fastest"),
        "minisectors": analysis.minisectors(sd, order[:3], 25),
        "corners": analysis.corners(sd),
        "straights": analysis.straights(sd),
        "long_runs": analysis.long_runs(sd),
        "engines": analysis.engines(sd),
    }
    if sd.is_race:
        out["race"] = analysis.race(sd)
    return out


class Demo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = {name: run_all(demo.load(name)) for name in SESSIONS}

    def test_everything_serialises(self):
        for name, res in self.results.items():
            for view, data in res.items():
                with self.subTest(session=name, view=view):
                    json.dumps(data)   # the server sends these as JSON

    def test_corners(self):
        for name, res in self.results.items():
            c = res["corners"]
            with self.subTest(session=name):
                self.assertTrue(c["available"])
                self.assertGreaterEqual(len(c["corners"]), 5)
                for row in c["corners"]:
                    self.assertEqual(max(row["teams"].values()), 0.0)   # quickest team is the reference
                for cls, group in c["summary"].items():
                    self.assertGreaterEqual(sum(1 for r in c["corners"] if r["class"] == cls), 2)

    def test_straights(self):
        st = self.results["Qualifying"]["straights"]
        self.assertTrue(st["clipping_relevant"])          # the demo track has a 1.6 km straight
        self.assertGreater(st["longest_straight"], 1000)
        for team, v in st["teams"].items():
            self.assertGreater(v["top"], 250)

    def test_long_runs_fuel_basis(self):
        self.assertEqual(self.results["Race"]["long_runs"]["fuel_basis"], "race")
        self.assertEqual(self.results["Practice 2"]["long_runs"]["fuel_basis"], "stint")

    def test_race_order(self):
        ov = self.results["Race"]["overview"]
        self.assertEqual(len(ov["order"]), 22)
        self.assertEqual(ov["meta"]["wet_share"], 0.0)

    def test_engines_cover_every_team(self):
        fams = self.results["Qualifying"]["engines"]["families"]
        teams = {t["team"] for f in fams for t in f["teams"]}
        self.assertEqual(len(teams), 11)


if __name__ == "__main__":
    unittest.main()
