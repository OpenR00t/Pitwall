# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Start the bundled backend (backend/dist), load the demo weekend and run
every analysis, so a release can't ship a backend that doesn't start."""

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXE = ROOT / "backend" / "dist" / "pitwall-backend" / ("pitwall-backend.exe" if sys.platform == "win32" else "pitwall-backend")
VIEWS = ["overview", "laps", "corners", "straights", "longruns", "engines", "race"]


def main():
    proc = subprocess.Popen([str(EXE), "--port", "0", "--token", "smoke"], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True)
    try:
        port = None
        start = time.time()
        for line in proc.stdout:
            if line.startswith("PITWALL_READY"):
                port = int(line.split()[1])
                break
            if time.time() - start > 120:
                break
        if port is None:
            sys.exit("backend didn't start")
        print(f"started in {time.time() - start:.1f}s")
        base = f"http://127.0.0.1:{port}/api/"

        def call(path, body=None):
            req = urllib.request.Request(base + path, headers={"X-Pitwall-Token": "smoke"},
                                         data=json.dumps(body).encode() if body else None,
                                         method="POST" if body else "GET")
            return json.loads(urllib.request.urlopen(req, timeout=60).read())

        health = call("health")
        if not health.get("fastf1"):
            sys.exit(f"FastF1 didn't import: {health.get('fastf1_error')}")
        demo = call("years")["demo"]
        job = call("load", {"year": demo, "round": 1, "session": "Race"})["job"]
        for _ in range(120):
            j = call(f"job/{job}")
            if j["state"] in ("done", "error"):
                break
            time.sleep(0.5)
        if j["state"] != "done":
            sys.exit(f"demo load failed: {j.get('error')}")
        key = j["result"]["session"]
        for v in VIEWS:
            r = call(f"s/{key}/{v}")
            if "error" in r:
                sys.exit(f"{v}: {r['error']}")
        print(f"ok: FastF1 {health.get('fastf1_version')}, demo race, {len(VIEWS)} views")
    finally:
        proc.kill()


if __name__ == "__main__":
    main()
