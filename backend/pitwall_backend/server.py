# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Local HTTP API for the app.

Listens on 127.0.0.1 only and requires the token it was started with on
every request, so other software and web pages on the machine can't use it.
Loading a session and building the season view run as background jobs the
app polls, since a first load can take a minute.
"""

from __future__ import annotations

import datetime as dt
import json
import secrets
import sys
import threading
import traceback
import uuid
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import __version__, analysis, demo

try:  # FastF1 is only needed for real data; the demo works without it
    from . import source_fastf1 as real
    real.enable_cache()
    REAL_ERROR = None
except Exception as exc:  # pragma: no cover - depends on the install
    real = None
    REAL_ERROR = f"{type(exc).__name__}: {exc}"

MAX_SESSIONS = 4


class State:
    def __init__(self):
        self.sessions: OrderedDict[str, object] = OrderedDict()
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()

    def put_session(self, key, sd):
        with self.lock:
            self.sessions[key] = sd
            self.sessions.move_to_end(key)
            while len(self.sessions) > MAX_SESSIONS:
                self.sessions.popitem(last=False)

    def get_session(self, key):
        with self.lock:
            sd = self.sessions.get(key)
            if sd is not None:
                self.sessions.move_to_end(key)
            return sd

    def start_job(self, kind: str, fn) -> str:
        job_id = uuid.uuid4().hex[:12]
        job = {"id": job_id, "kind": kind, "state": "running", "progress": [], "result": None,
               "error": None}
        self.jobs[job_id] = job

        def run():
            try:
                job["result"] = fn(lambda msg: job["progress"].append(msg))
                job["state"] = "done"
            except Exception as exc:
                job["state"] = "error"
                job["error"] = str(exc) or type(exc).__name__
                job["auth"] = real is not None and isinstance(exc, real.AuthRequired)
                traceback.print_exc()
        threading.Thread(target=run, daemon=True).start()
        return job_id


STATE = State()


def _session_key(year, rnd, session):
    return f"{year}-{rnd}-{session.lower().replace(' ', '_')}"


def years() -> list[int]:
    now = dt.date.today().year
    return list(range(now, 2017, -1))


def route(method: str, path: str, query: dict, body: dict):
    q = lambda k, d=None: query.get(k, [d])[0]  # noqa: E731
    parts = [p for p in path.split("/") if p][1:]  # drop "api"

    if parts == ["health"]:
        return {"ok": True, "version": __version__, "fastf1": real is not None,
                "fastf1_error": REAL_ERROR, "fastf1_version": _fastf1_version(),
                "python": sys.executable}
    if parts == ["years"]:
        return {"years": years(), "demo": demo.DEMO_YEAR}
    if parts == ["auth", "status"]:
        return real.auth_status() if real else {"signed_in": False, "unavailable": REAL_ERROR}
    if parts == ["auth", "signin"] and method == "POST":
        _need_real()
        return real.sign_in(body.get("username", ""), body.get("password", ""))
    if parts == ["auth", "signout"] and method == "POST":
        _need_real()
        return real.sign_out()
    if parts == ["schedule"]:
        year = int(q("year"))
        if year == demo.DEMO_YEAR:
            return {"year": year, "events": demo.schedule()}
        _need_real()
        return {"year": year, "events": real.schedule(year)}
    if parts == ["load"] and method == "POST":
        year, rnd, session = int(body["year"]), int(body["round"]), body["session"]
        key = _session_key(year, rnd, session)
        if STATE.get_session(key) is not None:
            return {"session": key, "cached": True}

        def job(report):
            if year == demo.DEMO_YEAR:
                report("Generating demo session")
                sd = demo.load(session)
            else:
                _need_real()
                sd = real.load(year, rnd, session, report)
            STATE.put_session(key, sd)
            return {"session": key}
        return {"job": STATE.start_job("load", job)}
    if parts == ["season"] and method == "POST":
        year = int(body["year"])

        def job(report):
            if year == demo.DEMO_YEAR:
                return {"year": year, "rounds": demo.season()}
            _need_real()
            return {"year": year, "rounds": real.season(year, report)}
        return {"job": STATE.start_job("season", job)}
    if parts[:1] == ["job"] and len(parts) == 2:
        job = STATE.jobs.get(parts[1])
        if job is None:
            raise LookupError("no such job")
        return {k: job.get(k) for k in ("id", "kind", "state", "progress", "result", "error",
                                        "auth")}
    if parts[:1] == ["s"] and len(parts) == 3:
        sd = STATE.get_session(parts[1])
        if sd is None:
            raise LookupError("session not loaded")
        view = parts[2]
        if view == "overview":
            return analysis.overview(sd)
        if view == "laps":
            return analysis.laps(sd)
        if view == "telemetry":
            return analysis.telemetry(sd, q("driver"), q("lap"))
        if view == "compare":
            specs = []
            for item in (q("laps") or "").split(","):
                if item:
                    abbr, _, lap = item.partition(":")
                    specs.append((abbr, lap or "fastest"))
            return analysis.compare(sd, specs)
        if view == "map":
            return analysis.track_map(sd, q("driver"), q("lap"))
        if view == "minisectors":
            return analysis.minisectors(sd, [a for a in (q("drivers") or "").split(",") if a],
                                        int(q("count", 25)))
        if view == "corners":
            return analysis.corners(sd)
        if view == "straights":
            return analysis.straights(sd)
        if view == "longruns":
            fuel = q("fuel")
            return analysis.long_runs(sd, float(fuel) if fuel not in (None, "") else None)
        if view == "engines":
            return analysis.engines(sd)
        if view == "race":
            return analysis.race(sd)
    raise LookupError(f"unknown endpoint {path}")


def _need_real():
    if real is None:
        msg = f"FastF1 isn't available to the Python running Pitwall ({sys.executable}): {REAL_ERROR}."
        if "No module named" in (REAL_ERROR or ""):
            msg += (" Install the requirements for that Python, or point Pitwall at the one that has them"
                    " with PITWALL_PYTHON.")
        raise RuntimeError(msg)


def _fastf1_version():
    try:
        import fastf1
        return fastf1.__version__
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    token = ""
    server_version = "Pitwall"

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Pitwall-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, status: int, payload):
        data = json.dumps(payload, allow_nan=False, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _handle(self, method):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return self._send(404, {"error": "not found"})
        if not secrets.compare_digest(self.headers.get("X-Pitwall-Token", ""), self.token):
            return self._send(401, {"error": "bad token"})
        body = {}
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                body = json.loads(self.rfile.read(length) or b"{}")
        try:
            return self._send(200, route(method, url.path, parse_qs(url.query), body))
        except LookupError as exc:
            return self._send(404, {"error": str(exc)})
        except Exception as exc:
            auth = real is not None and isinstance(exc, (real.AuthRequired, real.F1AuthError))
            if not auth:
                traceback.print_exc()
            return self._send(401 if auth else 500,
                              {"error": str(exc) or type(exc).__name__, "auth": auth})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


def serve(port: int = 0, token: str | None = None):
    Handler.token = token or secrets.token_urlsafe(24)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    # the app reads this line to find the server
    print(f"PITWALL_READY {httpd.server_address[1]} {Handler.token}", flush=True)
    httpd.serve_forever()
