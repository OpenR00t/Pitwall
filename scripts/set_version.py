# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Set Pitwall's version everywhere it's written down, or check they agree.

    python scripts/set_version.py 0.2.0     # before tagging a release
    python scripts/set_version.py --check   # prints the version; fails if the files disagree
    python scripts/set_version.py --check v0.2.0   # ...or if it isn't this tag
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAURI = ROOT / "src-tauri" / "tauri.conf.json"
CARGO = ROOT / "src-tauri" / "Cargo.toml"
BACKEND = ROOT / "backend" / "pitwall_backend" / "__init__.py"
CARGO_RE = re.compile(r'(?m)^(version\s*=\s*")([^"]+)(")', )
BACKEND_RE = re.compile(r'(?m)^(__version__\s*=\s*")([^"]+)(")')


def current() -> dict:
    return {
        "tauri.conf.json": json.loads(TAURI.read_text(encoding="utf-8"))["version"],
        "Cargo.toml": CARGO_RE.search(CARGO.read_text(encoding="utf-8")).group(2),
        "pitwall_backend": BACKEND_RE.search(BACKEND.read_text(encoding="utf-8")).group(2),
    }


def set_version(v: str):
    if not re.fullmatch(r"\d+\.\d+\.\d+", v):
        sys.exit(f"not a version: {v} (expected e.g. 0.2.0)")
    conf = json.loads(TAURI.read_text(encoding="utf-8"))
    conf["version"] = v
    TAURI.write_text(json.dumps(conf, indent=2) + "\n", encoding="utf-8")
    CARGO.write_text(CARGO_RE.sub(lambda m: m.group(1) + v + m.group(3), CARGO.read_text(encoding="utf-8"), count=1),
                     encoding="utf-8")
    BACKEND.write_text(BACKEND_RE.sub(lambda m: m.group(1) + v + m.group(3), BACKEND.read_text(encoding="utf-8"), count=1),
                       encoding="utf-8")
    print(f"version set to {v}")


def check(tag: str | None):
    found = current()
    versions = set(found.values())
    if len(versions) != 1:
        sys.exit("versions disagree: " + ", ".join(f"{k} {v}" for k, v in found.items()))
    v = versions.pop()
    if tag is not None and tag.lstrip("v") != v:
        sys.exit(f"tag {tag} doesn't match the version in the files ({v})")
    print(v)


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--check"]:
        check(args[1] if len(args) > 1 else None)
    elif len(args) == 1:
        set_version(args[0])
    else:
        sys.exit(__doc__)
