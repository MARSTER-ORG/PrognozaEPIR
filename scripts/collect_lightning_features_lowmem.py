#!/usr/bin/env python3
"""Low-memory wrapper for the MTG LI LFL collector.

The heavy EUMETSAT/netCDF stack lives only for the duration of this child
process. A compact Europe-only cache is persisted in /tmp so consecutive
5-minute runs preserve the LFL history without re-downloading the whole
bootstrap window every time.

A temporary EUMETSAT catalogue/index gap must not replace the last valid
Europe-wide snapshot with an empty error document. The previous snapshot is
kept with its original flash timestamps, so downstream 50 km alert logic never
mistakes cached flashes for new flashes.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Deployment marker: LFL Europe-wide continuity r8 / 2026-09-15.
ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import collect_lightning_features as core  # noqa: E402

# EUMETSAT product publication/catalogue indexing can lag the nominal cadence.
# Keep the geographical scope Europe-wide; only widen the source discovery
# window. The individual flash age filters in the core collector remain intact.
core.LOOKBACK_MIN = int(os.environ.get("LFL_LOOKBACK_MIN", "45"))

CACHE_PATH = Path(os.environ.get("LFL_PERSIST_CACHE", "/tmp/prognozaepir-lfl-cache.json"))


def parse_utc(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def load_cache() -> None:
    try:
        payload = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return

    for row in payload.get("flashes") or []:
        if not isinstance(row, dict):
            continue
        when = parse_utc(row.get("time"))
        try:
            lat = float(row.get("lat"))
            lon = float(row.get("lon"))
        except (TypeError, ValueError):
            continue
        if when is None:
            continue
        item = {"time": when, "lat": lat, "lon": lon}
        try:
            confidence = float(row.get("filter_confidence"))
        except (TypeError, ValueError):
            confidence = None
        if confidence is not None:
            item["filter_confidence"] = confidence
        core._flash_cache[core._flash_key(item)] = item

    seen = payload.get("seen_products") or {}
    if isinstance(seen, dict):
        for product_id, value in seen.items():
            when = parse_utc(value)
            if when is not None:
                core._seen_products[str(product_id)] = when

    core._prune_cache(core.utc_now())


def save_cache() -> None:
    now = core.utc_now()
    core._prune_cache(now)
    flashes = []
    for item in core._flash_cache.values():
        lat = float(item["lat"])
        lon = float(item["lon"])
        # Only Europe is required by the published overlay and EPIR radial
        # statistics. Discarding the rest keeps the persistent state compact.
        if not (core.EU_MIN_LAT <= lat <= core.EU_MAX_LAT and core.EU_MIN_LON <= lon <= core.EU_MAX_LON):
            continue
        row = {"time": core.iso(item["time"]), "lat": lat, "lon": lon}
        if "filter_confidence" in item:
            row["filter_confidence"] = item["filter_confidence"]
        flashes.append(row)

    payload = {
        "schema": "prognozaepir-lfl-persist-v1",
        "updated_at": core.iso(now),
        "flashes": flashes,
        "seen_products": {key: core.iso(value) for key, value in core._seen_products.items()},
    }
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_PATH.with_name(f".{CACHE_PATH.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(tmp, CACHE_PATH)


def load_previous_snapshot() -> dict | None:
    try:
        payload = json.loads(core.OUT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if payload.get("schema") != "prognozaepir-lightning-features-v1":
        return None
    if payload.get("status") not in {"ok", "stale"}:
        return None
    return payload


def main() -> int:
    load_cache()
    previous = load_previous_snapshot()
    payload = core.collect_and_write()

    if payload.get("status") == "error" and previous is not None:
        failure_reason = payload.get("reason") or "temporary EUMETSAT LFL collector failure"
        payload = dict(previous)
        payload["collector_health"] = {
            "status": "degraded",
            "reason": failure_reason,
            "checked_at": core.iso(core.utc_now()),
            "fallback": "last-valid-Europe-wide-snapshot",
        }
        core.atomic_json(core.OUT, payload)

    if payload.get("status") in {"ok", "stale"}:
        save_cache()

    print(json.dumps({
        "status": payload.get("status"),
        "updated_at": payload.get("updated_at"),
        "europe_flashes_20min": payload.get("europe_flashes_20min"),
        "points": len(payload.get("points") or []),
        "downloaded_products_this_cycle": (payload.get("source") or {}).get("downloaded_products_this_cycle"),
        "persisted_cache": str(CACHE_PATH),
        "collector_health": payload.get("collector_health"),
        "reason": payload.get("reason"),
    }, ensure_ascii=False), flush=True)
    return 0 if payload.get("status") in {"ok", "stale", "disabled"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
