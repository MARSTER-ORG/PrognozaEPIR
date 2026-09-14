#!/usr/bin/env python3
"""Compatibility entrypoint that keeps central_ingestor unchanged except for TAF source scheduling."""
from __future__ import annotations

import central_ingestor as base

_original_script = base.script


def _script(name: str, *args: str) -> list[str]:
    if name == "collect_neighbor_tafs.py":
        name = "collect_neighbor_tafs_tiered.py"
    return _original_script(name, *args)


base.script = _script


if __name__ == "__main__":
    raise SystemExit(base.main())
