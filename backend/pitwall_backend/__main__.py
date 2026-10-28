# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""python -m pitwall_backend [--port N] [--token T]"""

import argparse
import os

from .server import serve


def main():
    p = argparse.ArgumentParser(prog="python -m pitwall_backend")
    p.add_argument("--port", type=int, default=int(os.environ.get("PITWALL_PORT", 0)),
                   help="port to listen on (0 = any free port)")
    p.add_argument("--token", default=os.environ.get("PITWALL_TOKEN"),
                   help="token clients must send (random if not given)")
    a = p.parse_args()
    serve(a.port, a.token)


if __name__ == "__main__":
    main()
