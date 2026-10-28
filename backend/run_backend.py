# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The Pitwall contributors
"""Entry point for the bundled (frozen) backend. In development the app runs
`python -m pitwall_backend` instead."""

from pitwall_backend.__main__ import main

if __name__ == "__main__":
    main()
