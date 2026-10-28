# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Build the backend as a standalone folder for the desktop app's installer.

    pip install -r requirements.txt pyinstaller
    python build_frozen.py

The result is `dist/pitwall-backend/`, a folder holding `pitwall-backend`
(`pitwall-backend.exe` on Windows) and everything it needs, so users don't
need Python. A folder starts faster than a single self-extracting file and is
less often flagged by antivirus software.
"""

import shutil
import sys
from pathlib import Path

import PyInstaller.__main__

HERE = Path(__file__).resolve().parent


def main():
    for d in ("build", "dist"):
        shutil.rmtree(HERE / d, ignore_errors=True)
    PyInstaller.__main__.run([
        str(HERE / "run_backend.py"),
        "--name", "pitwall-backend",
        "--onedir",
        "--noconfirm",
        "--console",            # the app hides the window; stdout carries the port
        "--paths", str(HERE),
        "--collect-submodules", "pitwall_backend",
        "--collect-all", "fastf1",
        "--collect-data", "timple",
        "--collect-data", "platformdirs",
        "--distpath", str(HERE / "dist"),
        "--workpath", str(HERE / "build"),
        "--specpath", str(HERE / "build"),
    ])
    exe = HERE / "dist" / "pitwall-backend" / ("pitwall-backend.exe" if sys.platform == "win32" else "pitwall-backend")
    if not exe.is_file():
        sys.exit(f"build failed: {exe} missing")
    print(f"built {exe}")


if __name__ == "__main__":
    main()
