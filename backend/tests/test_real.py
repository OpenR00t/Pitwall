# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Real sessions against their stored summaries (`snapshots/real.json`).

Opt in, since each session takes a few seconds to load:

    PITWALL_REAL_TESTS=1 python -m unittest tests.test_real -v

Only sessions already in the FastF1 cache are checked; the rest are skipped.
To check only some, list them (keys as in the snapshot file):

    PITWALL_REAL_SESSIONS=2026-16-Race,2026-13-Qualifying
A failure names the session and what changed. If the change is intended,
store new summaries with `python -m tests.snapshot --update`.
"""

import json
import os
import unittest

from tests import snapshot

ENABLED = os.environ.get("PITWALL_REAL_TESTS") == "1" or bool(os.environ.get("PITWALL_REAL_SESSIONS"))
ONLY = {k.strip() for k in os.environ.get("PITWALL_REAL_SESSIONS", "").split(",") if k.strip()}

# whole km/h and whole metres are what the data carries; allow for rounding
SPEED_TOL = 1.0
FLAT_TOL = 20.0


@unittest.skipUnless(ENABLED, "set PITWALL_REAL_TESTS=1 to check real sessions")
class RealSessions(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.stored = json.loads(snapshot.SNAPSHOT.read_text()) if snapshot.SNAPSHOT.exists() else {}
        snapshot.open_cache()

    def test_sessions(self):
        checked = 0
        for year, rnd, name in snapshot.SESSIONS:
            k = snapshot.key(year, rnd, name)
            if ONLY and k not in ONLY:
                continue
            with self.subTest(session=k):
                if k not in self.stored:
                    self.skipTest(f"{k}: no stored summary")
                if not snapshot.cached(year, rnd, name):
                    continue
                now = snapshot.summarise(snapshot.load(year, rnd, name))
                self.compare(k, self.stored[k], now)
                checked += 1
        if not checked:
            self.skipTest("none of the sessions are in the cache")

    def compare(self, k, old, new):
        for field in ("event", "order", "corners_estimated", "lap_notes"):
            self.assertEqual(old.get(field), new.get(field), f"{k}: {field}")
        self.assertAlmostEqual(old.get("wet_share", 0), new.get("wet_share", 0), places=2, msg=f"{k}: wet share")
        if "corners" in old:
            oc, nc = old["corners"], new.get("corners", {})
            for f in ("kept", "linked", "classes", "rank"):
                self.assertEqual(oc[f], nc.get(f), f"{k}: corners {f}")
            self.assertLessEqual(abs(oc["outlier_cells"] - nc.get("outlier_cells", 0)), 1, f"{k}: outlier cells")
        if "straights" in old:
            os_, ns = old["straights"], new.get("straights", {})
            self.assertEqual(os_["clipping_relevant"], ns.get("clipping_relevant"), f"{k}: clipping relevant")
            self.assertAlmostEqual(os_["longest"], ns.get("longest", 0), delta=20, msg=f"{k}: longest straight")
            for t, v in os_["top"].items():
                self.assertAlmostEqual(v, ns["top"].get(t), delta=SPEED_TOL, msg=f"{k}: top speed {t}")
            for t, v in os_["flat"].items():
                if v is not None:
                    self.assertAlmostEqual(v, ns["flat"].get(t), delta=FLAT_TOL, msg=f"{k}: clipping {t}")
        if "long_runs" in old:
            self.assertEqual(old["long_runs"], new.get("long_runs"), f"{k}: long runs")
        if "engines" in old:
            self.assertEqual(old["engines"], new.get("engines"), f"{k}: engine families")
        self.assertLessEqual(new.get("delta_end_error", 0), 0.02, f"{k}: delta doesn't end at the lap-time gap")
        self.assertLessEqual(new.get("delta_sector_error", 0), 0.03, f"{k}: delta misses the official sector-time gaps")
        self.assertLessEqual(new.get("minisector_sum_error", 0), 0.02, f"{k}: mini-sectors don't add up to the lap time")
        self.assertLessEqual(new.get("compare_track_gap_m", 0), 40, f"{k}: compared laps aren't at the same place on track")
        if "line_speed_p90" in old:
            self.assertLessEqual(new.get("line_speed_p90", 0), old["line_speed_p90"] + 1.0,
                                 f"{k}: telemetry speed at the line drifts further from the official reading")
        if "drs_open" in old:
            self.assertEqual(old["drs_open"], new.get("drs_open"), f"{k}: DRS channel")
        for t, v in old.get("quali_gaps", {}).items():
            self.assertAlmostEqual(v, new["quali_gaps"].get(t), places=3, msg=f"{k}: qualifying gap {t}")


if __name__ == "__main__":
    unittest.main()
