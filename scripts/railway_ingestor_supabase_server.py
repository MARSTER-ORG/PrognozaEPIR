#!/usr/bin/env python3
"""Compatibility entrypoint for the Supabase-primary Railway runtime.

Supabase synchronisation is now part of the full and fast ingest paths, so a
third independent mirror scheduler is intentionally no longer started here.
"""
from __future__ import annotations

import railway_ingestor_fast_server as fast


def main() -> int:
    return fast.main()


if __name__ == "__main__":
    raise SystemExit(main())
