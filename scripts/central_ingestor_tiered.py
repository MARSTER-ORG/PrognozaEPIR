#!/usr/bin/env python3
"""Compatibility entrypoint for tiered TAF scheduling and freshness ordering."""
from __future__ import annotations

import central_ingestor as base

_original_script = base.script


def _script(name: str, *args: str) -> list[str]:
    if name == "collect_neighbor_tafs.py":
        name = "collect_neighbor_tafs_tiered.py"
    elif name == "check_epir_archive_freshness.py" and "--metar-only" in args:
        # Acquisition writes the new routine METAR to durable staging before
        # the precheck. Normalize that staging first so the gate cannot see the
        # authoritative archive one step behind and start needless recovery.
        name = "check_epir_archive_freshness_after_normalize.py"
    return _original_script(name, *args)


base.script = _script


if __name__ == "__main__":
    raise SystemExit(base.main())
