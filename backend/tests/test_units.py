# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Unit tests for the calculations, on small synthetic laps.

Each test pins down a case real sessions have exposed: close corners, speed and
position out of sync, a straight cut by the finish line, a stall in the middle
of a straight, deleted laps, missing tyre ages. Run from the backend folder:

    python -m unittest discover -s tests
"""

import unittest

import numpy as np
import pandas as pd

from pitwall_backend import analysis


def lap(distance, speed, throttle=None, x=None):
    """A telemetry frame along a straight line (X = distance × 10, like FastF1)."""
    d = np.asarray(distance, float)
    v = np.asarray(speed, float)
    return pd.DataFrame({
        "Distance": d, "Speed": v,
        "Throttle": np.full(len(d), 100.0) if throttle is None else np.asarray(throttle, float),
        "X": d * 10 if x is None else np.asarray(x, float), "Y": np.zeros(len(d)),
    })


def corner(distance, number=1):
    return {"number": number, "letter": "", "distance": distance, "x": distance * 10, "y": 0.0}


class CornerMinimums(unittest.TestCase):
    def test_close_corners_are_measured_separately(self):
        d = np.arange(0, 2000, 5.0)
        v = 300 - 150 * np.exp(-((d - 1000) / 25) ** 2) - 100 * np.exp(-((d - 1080) / 25) ** 2)
        mins = analysis._corner_minimums(lap(d, v), [corner(990, 1), corner(1090, 2)])
        self.assertAlmostEqual(mins[0], 150, delta=2)
        self.assertAlmostEqual(mins[1], 200, delta=2)

    def test_corner_found_by_position_not_distance(self):
        # the lap's distance runs 60 m long, but the map position is right
        d = np.arange(0, 2000, 5.0)
        v = 300 - 180 * np.exp(-((d - 1000) / 25) ** 2)
        tel = lap(d + 60, v, x=d * 10)
        self.assertAlmostEqual(analysis._corner_minimums(tel, [corner(1000)])[0], 120, delta=2)

    def test_no_dip_means_no_reading(self):
        # speed out of sync with position: flat through a braking zone
        d = np.arange(0, 2000, 5.0)
        mins = analysis._corner_minimums(lap(d, np.full(len(d), 308.0)), [corner(1000)])
        self.assertIsNone(mins[0])

    def test_slowest_point_on_a_cut_edge_is_skipped(self):
        # second corner 60 m after the first, car still accelerating through it
        d = np.arange(0, 2000, 5.0)
        v = np.where(d < 1000, 300 - (d / 1000) * 200, 100 + (d - 1000) * 0.5)
        mins = analysis._corner_minimums(lap(d, v), [corner(1000, 1), corner(1060, 2)])
        self.assertIsNotNone(mins[0])
        self.assertIsNone(mins[1])


class Straights(unittest.TestCase):
    def test_straight_across_the_finish_line_is_joined(self):
        d = np.arange(0, 5000, 10.0)
        thr = np.where((d < 600) | (d > 4400), 100.0, 40.0)
        v = np.where(thr > 50, 300.0, 150.0)
        segs = analysis._full_throttle_segments(lap(d, v, thr))
        lengths = sorted(round(sd[-1] - sd[0]) for sd, _ in segs)
        self.assertEqual(len(segs), 1)
        self.assertGreater(lengths[0], 1150)   # 590 m at the end + 600 m at the start

    def test_mid_straight_stall_counts_as_clipping(self):
        # accelerates, stalls for 300 m, accelerates again to the braking point
        d = np.arange(0, 1500, 5.0)
        v = np.interp(d, [0, 500, 800, 1500], [200, 300, 301, 330])
        self.assertGreaterEqual(analysis._stalled_metres(d, v), 250)

    def test_car_still_accelerating_does_not_clip(self):
        d = np.arange(0, 1000, 5.0)
        v = 200 + d * 0.12
        self.assertEqual(analysis._stalled_metres(d, v), 0.0)

    def test_fade_before_braking_counts(self):
        d = np.arange(0, 1500, 5.0)
        v = np.interp(d, [0, 700, 1500], [200, 330, 310])
        self.assertGreaterEqual(analysis._stalled_metres(d, v), 700)


class Delta(unittest.TestCase):
    def test_delta_ends_at_the_lap_time_gap_when_lengths_differ(self):
        from pitwall_backend.model import SessionData

        def tel(length, laptime):
            d = np.linspace(0, length, 400)
            return pd.DataFrame({"Distance": d, "Time": d / length * laptime, "X": d * 10, "Y": d * 0,
                                 "Speed": np.full(400, 200.0), "Throttle": 100.0, "Brake": 0.0,
                                 "nGear": 7.0, "RPM": 11000.0, "DRS": 0.0})
        laps = {("A", 1): tel(5000, 90.0), ("B", 1): tel(5050, 90.3)}   # B's lap measures 1% long
        sd = SessionData(meta={"type": "Q"}, drivers=[], laps=pd.DataFrame({
            "Driver": ["A", "B"], "LapNumber": [1, 1], "LapTime": pd.to_timedelta([90.0, 90.3], unit="s")}),
            results=pd.DataFrame(), telemetry=lambda a, n: laps.get((a, n)))
        sd._typical_length = 5000.0
        c = analysis.compare(sd, [("A", 1), ("B", 1)])
        self.assertAlmostEqual(c["series"][1]["delta"][-1], 0.3, places=2)
        self.assertAlmostEqual(c["series"][1]["delta"][len(c["distance"]) // 2], 0.15, places=2)
        self.assertGreater(c["series"][1]["length_off_pct"], 0.9)

    def test_delta_passes_through_the_sector_lines(self):
        from pitwall_backend.model import SessionData

        def tel(length, pace):
            # pace: seconds for each third of the lap; the lap's own distance is off by 3%
            d = np.linspace(0, length, 600)
            t = np.interp(d, [0, length / 3, 2 * length / 3, length], np.cumsum([0, *pace]))
            return pd.DataFrame({"Distance": d, "Time": t, "X": d * 10, "Y": d * 0, "Speed": 200.0,
                                 "Throttle": 100.0, "Brake": 0.0, "nGear": 7.0, "RPM": 11000.0, "DRS": 0.0})
        laps = {("A", 1): tel(5000, [30.0, 30.0, 30.0]), ("B", 1): tel(5150, [30.5, 29.8, 30.1])}
        frame = pd.DataFrame({"Driver": ["A", "B"], "LapNumber": [1, 1],
                              "LapTime": pd.to_timedelta([90.0, 90.4], unit="s"),
                              "Sector1Time": pd.to_timedelta([30.0, 30.5], unit="s"),
                              "Sector2Time": pd.to_timedelta([30.0, 29.8], unit="s")})
        sd = SessionData(meta={"type": "Q"}, drivers=[], laps=frame, results=pd.DataFrame(),
                         telemetry=lambda a, n: laps.get((a, n)))
        sd._typical_length = 5000.0
        c = analysis.compare(sd, [("A", 1), ("B", 1)], points=3001)
        dist, delta = np.array(c["distance"]), np.array(c["series"][1]["delta"])
        at = lambda x: delta[int(np.argmin(np.abs(dist - x)))]
        self.assertAlmostEqual(at(5000 / 3), 0.5, places=2)        # S1 gap
        self.assertAlmostEqual(at(2 * 5000 / 3), 0.3, places=2)    # S1 + S2 gap
        self.assertAlmostEqual(delta[-1], 0.4, places=2)           # lap gap


    def test_minisectors_add_up_to_the_lap_time(self):
        from pitwall_backend.model import SessionData

        def tel(length, laptime):
            d = np.linspace(0, length, 500)
            return pd.DataFrame({"Distance": d, "Time": d / length * laptime, "X": d * 10, "Y": d * 0,
                                 "Speed": 200.0, "Throttle": 100.0, "Brake": 0.0, "nGear": 7.0,
                                 "RPM": 11000.0, "DRS": 0.0})
        # B's lap measures 4% short: cutting both laps at the shorter length
        # would drop the end of A's lap
        laps = {("A", 1): tel(5000, 80.0), ("B", 1): tel(4800, 80.2)}
        sd = SessionData(meta={"type": "Q"}, drivers=[], laps=pd.DataFrame({
            "Driver": ["A", "B"], "LapNumber": [1, 1], "LapTime": pd.to_timedelta([80.0, 80.2], unit="s")}),
            results=pd.DataFrame(), telemetry=lambda a, n: laps.get((a, n)))
        sd.fastest_lap_number = lambda a: 1
        m = analysis.minisectors(sd, ["A", "B"], 10)
        for a, lt in (("A", 80.0), ("B", 80.2)):
            self.assertAlmostEqual(sum(x["times"][a] for x in m["sectors"]), lt, places=2)


class LapCheck(unittest.TestCase):
    def session(self, laps, corners):
        from pitwall_backend.model import Driver, SessionData
        frame = pd.DataFrame([{"Driver": a, "LapNumber": n, "LapTime": pd.to_timedelta(t, unit="s"), "Team": "T"}
                              for (a, n), (t, _) in laps.items()])
        sd = SessionData(meta={"type": "R"}, drivers=[Driver(abbr=a, number="1", name=a, team=f"T{a}", color="#fff")
                                                        for a in sorted({a for a, _ in laps})],
                         laps=frame, results=pd.DataFrame(), telemetry=lambda a, n: laps[(a, n)][1])
        sd.corners = corners
        return sd

    @staticmethod
    def loop(start=0.0, length=5000.0, keep=1.0):
        """A lap round a circle with one slow corner at 1000 m; the telemetry
        is cut `start` metres past the line, and only `keep` of it kept."""
        d = np.arange(0, length * keep, 5.0)
        true = (d + start) % length
        ang = true / length * 2 * np.pi
        v = 280 - 180 * np.exp(-((true - 1000) / 40) ** 2)
        return pd.DataFrame({"Distance": d, "Speed": v, "Throttle": 100.0, "Time": d / 70,
                             "X": np.cos(ang) * 8000, "Y": np.sin(ang) * 8000})

    def test_cut_short_lap_is_swapped_for_the_next_one(self):
        corners = [{"number": 1, "letter": "", "distance": 1000.0, "x": np.cos(0.4 * np.pi) * 8000,
                    "y": np.sin(0.4 * np.pi) * 8000}]
        laps = {("A", 1): (90.0, self.loop()), ("B", 1): (90.1, self.loop()), ("C", 1): (90.2, self.loop()),
                ("D", 5): (90.0, self.loop(start=4000, keep=0.96)), ("D", 6): (90.3, self.loop())}
        sd = self.session(laps, corners)
        checked = analysis._checked_laps(sd)
        self.assertEqual(checked["D"][0], 6)
        self.assertIn("lap 5", analysis.lap_notes(sd)["D"])

    def test_shifted_whole_lap_is_realigned(self):
        corners = [{"number": 1, "letter": "", "distance": 1000.0, "x": np.cos(0.4 * np.pi) * 8000,
                    "y": np.sin(0.4 * np.pi) * 8000}]
        laps = {("A", 1): (90.0, self.loop()), ("B", 1): (90.1, self.loop()), ("C", 1): (90.2, self.loop()),
                ("D", 1): (90.0, self.loop(start=1200))}
        sd = self.session(laps, corners)
        n, tel, note = analysis._checked_laps(sd)["D"]
        self.assertIn("past the line", note)
        # the corner's slowest point is back at 1000 m
        i = int(np.argmin(tel["Speed"].to_numpy()))
        self.assertAlmostEqual(float(tel["Distance"].iloc[i]), 1000, delta=10)

    def test_compared_laps_line_up_on_track(self):
        # D's telemetry is cut 1200 m round the lap: after alignment both laps
        # must be at the same place on track at the same distance, and the
        # delta must still end at the lap-time gap
        laps = {("A", 1): (90.0, self.loop()), ("D", 1): (90.5, self.loop(start=1200))}
        laps[("D", 1)][1]["Time"] = np.linspace(0, 90.5, len(laps[("D", 1)][1]))
        laps[("A", 1)][1]["Time"] = np.linspace(0, 90.0, len(laps[("A", 1)][1]))
        for key in laps:
            for c in ("Brake", "nGear", "RPM", "DRS"):
                laps[key][1][c] = 0.0
        sd = self.session(laps, [])
        length, aligned = analysis._aligned(sd, [("A", 1, laps[("A", 1)][1]), ("D", 1, laps[("D", 1)][1])])
        self.assertAlmostEqual(abs(aligned[1][4]), 1200, delta=10)
        grid = np.linspace(0, length, 400)
        a, d = (analysis._on_grid(t, grid) for _, _, t, _, _ in aligned)
        self.assertLess(float(np.median(np.hypot(a["X"] - d["X"], a["Y"] - d["Y"]))), 20)
        c = analysis.compare(sd, [("A", 1), ("D", 1)])
        self.assertAlmostEqual(c["series"][1]["delta"][-1], 0.5, places=2)
        # no step where the turned lap joins up, or at the line
        delta = np.array(c["series"][1]["delta"])
        self.assertLess(float(np.abs(np.diff(delta)).max()), 0.01)
        self.assertTrue(np.all(np.diff(c["series"][1]["time"]) >= 0))

    def test_slow_lap_is_left_out(self):
        laps = {("A", 1): (90.0, self.loop()), ("B", 1): (90.1, self.loop()), ("C", 1): (120.0, self.loop())}
        sd = self.session(laps, [])
        self.assertIsNone(analysis._checked_laps(sd)["C"][0])


class Laps(unittest.TestCase):
    def test_slope_ignores_missing_values(self):
        x = np.array([1, 2, np.nan, 4, 5], float)
        y = np.array([90.0, 90.1, 90.2, 90.3, 90.4])
        self.assertAlmostEqual(analysis._slope(x, y), 0.1, places=6)
        self.assertEqual(analysis._slope(np.array([np.nan, np.nan]), np.array([1.0, 2.0])), 0.0)
        self.assertEqual(analysis._slope(np.array([3.0, 3.0]), np.array([1.0, 2.0])), 0.0)

    def test_unknown_compounds(self):
        for raw in (None, "None", "nan", np.nan, "", "UNKNOWN"):
            self.assertEqual(analysis._compound(raw), "UNKNOWN")
        self.assertEqual(analysis._compound("soft"), "SOFT")


class Fuel(unittest.TestCase):
    def frame(self, year, kind, laps):
        from pitwall_backend.model import SessionData
        sd = SessionData(meta={"type": kind, "year": year}, drivers=[],
                         laps=pd.DataFrame({"LapNumber": np.arange(1, laps + 1)}),
                         results=pd.DataFrame(), telemetry=lambda a, n: None)
        sd._typical_length = 305_000.0 / laps
        return sd

    def test_fuel_follows_the_rules_and_race_length(self):
        # 100 kg over 50 laps before 2026, about 70 kg from 2026
        self.assertAlmostEqual(analysis.default_fuel(self.frame(2025, "R", 50)), 0.07, places=3)
        self.assertAlmostEqual(analysis.default_fuel(self.frame(2026, "R", 50)), 0.049, places=3)
        # outside the race the lap count comes from a 305 km race distance
        self.assertAlmostEqual(analysis.default_fuel(self.frame(2026, "FP", 50)), 0.049, places=3)


class Repeat(unittest.TestCase):
    def test_rank_agreement(self):
        a = {k: v for k, v in zip("abcdefgh", range(8))}
        self.assertEqual(analysis._repeat(a, a), 1.0)
        self.assertEqual(analysis._repeat(a, {k: -v for k, v in a.items()}), -1.0)
        self.assertIsNone(analysis._repeat({"a": 1, "b": 2}, {"a": 1, "b": 2}))   # too few to say


class SeasonGaps(unittest.TestCase):
    def test_deleted_laps_do_not_count(self):
        from pitwall_backend.source_fastf1 import quali_gaps
        laps = pd.DataFrame({
            "Team": ["A", "A", "B", "B"],
            "LapTime": pd.to_timedelta([90.0, 89.0, 89.5, 91.0], unit="s"),
            "Deleted": [False, True, False, False],   # A's 89.0 was deleted
        })
        gaps = quali_gaps(laps)
        self.assertEqual(gaps["B"], 0.0)
        self.assertAlmostEqual(gaps["A"], round((90.0 / 89.5 - 1) * 100, 3))


if __name__ == "__main__":
    unittest.main()
