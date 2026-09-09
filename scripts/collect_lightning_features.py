#!/usr/bin/env python3
"""Collect EUMETSAT MTG LI L2 Lightning Flashes (LFL).

The collector keeps a rolling in-memory cache of recent flashes. EPIR
aggregates are derived from that cache, while a compact Europe-wide point
sample is exposed for the interactive radar map.

LI AFA imagery is deliberately not used here.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "lightning" / "latest.json"

EPIR_LAT = float(os.environ.get("EPIR_LAT", "52.8275"))
EPIR_LON = float(os.environ.get("EPIR_LON", "18.3175"))
COLLECTION_ID = os.environ.get("EUMETSAT_COLLECTION_ID", "EO:EUM:DAT:0691")
ENABLED = os.environ.get("LIGHTNING_FEATURES_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}

RADII_KM = (20, 40, 80, 150)
WINDOWS_MIN = (5, 10, 20)
LOOKBACK_MIN = 24
MAX_FEATURE_AGE_MIN = 22
MAX_MAP_POINTS = int(os.environ.get("LFL_MAX_MAP_POINTS", "2500"))
BOOTSTRAP_PRODUCTS = int(os.environ.get("LFL_BOOTSTRAP_PRODUCTS", "72"))

EU_MIN_LAT = float(os.environ.get("LFL_EUROPE_MIN_LAT", "30"))
EU_MAX_LAT = float(os.environ.get("LFL_EUROPE_MAX_LAT", "72"))
EU_MIN_LON = float(os.environ.get("LFL_EUROPE_MIN_LON", "-15"))
EU_MAX_LON = float(os.environ.get("LFL_EUROPE_MAX_LON", "45"))

_flash_cache: dict[tuple[int, int, int], dict[str, Any]] = {}
_seen_products: dict[str, datetime] = {}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def disabled_payload(reason: str) -> dict[str, Any]:
    now = utc_now()
    return {
        "schema": "prognozaepir-lightning-features-v1",
        "updated_at": iso(now),
        "status": "disabled",
        "reason": reason,
        "source": {
            "provider": "EUMETSAT",
            "instrument": "MTG Lightning Imager",
            "product": "LI L2 Lightning Flashes (LFL)",
            "collection": COLLECTION_ID,
            "note": "actual LFL points; LI AFA is not used",
        },
        "point": {"name": "EPIR", "lat": EPIR_LAT, "lon": EPIR_LON},
        "map_scope": {"min_lat": EU_MIN_LAT, "max_lat": EU_MAX_LAT, "min_lon": EU_MIN_LON, "max_lon": EU_MAX_LON},
        "radial_counts_20min": {str(r): 0 for r in RADII_KM},
        "time_counts_80km": {str(w): 0 for w in WINDOWS_MIN},
        "nearest": None,
        "trend_80km": None,
        "centroid": None,
        "motion": None,
        "points": [],
    }


def _as_datetime(seconds_since_2000: float) -> datetime:
    return datetime(2000, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=float(seconds_since_2000))


def _aware(dt: datetime | None) -> datetime:
    if not isinstance(dt, datetime):
        return datetime.min.replace(tzinfo=timezone.utc)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _download_body(product: Any, target_dir: Path) -> Path:
    entries = [str(e) for e in product.entries]
    body = next((e for e in entries if "CHK-BODY" in e and e.lower().endswith(".nc")), None)
    if body is None:
        body = next((e for e in entries if e.lower().endswith(".nc") and "TRAIL" not in e), None)
    if body is None:
        raise RuntimeError(f"LFL product {product} has no body NetCDF entry")
    with product.open(entry=body) as src:
        name = Path(getattr(src, "name", Path(body).name)).name
        dest = target_dir / name
        with dest.open("wb") as out:
            shutil.copyfileobj(src, out)
    return dest


def _records_from_netcdf(path: Path) -> list[dict[str, Any]]:
    import numpy as np
    from netCDF4 import Dataset

    out: list[dict[str, Any]] = []
    with Dataset(path, "r") as ds:
        for name in ("flash_time", "latitude", "longitude"):
            if name not in ds.variables:
                raise RuntimeError(f"{path.name}: missing LFL variable {name}")

        # netCDF4 applies scale_factor/add_offset automatically. For LFL that
        # means latitude/longitude arrive already in degrees.
        times = np.ma.filled(ds.variables["flash_time"][:], np.nan)
        lats = np.ma.filled(ds.variables["latitude"][:], np.nan)
        lons = np.ma.filled(ds.variables["longitude"][:], np.nan)
        confidence = None
        if "flash_filter_confidence" in ds.variables:
            confidence = np.ma.filled(ds.variables["flash_filter_confidence"][:], np.nan)

        n = min(len(times), len(lats), len(lons))
        for i in range(n):
            t, lat, lon = float(times[i]), float(lats[i]), float(lons[i])
            if not (math.isfinite(t) and math.isfinite(lat) and math.isfinite(lon)):
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                continue
            item = {"time": _as_datetime(t), "lat": lat, "lon": lon}
            if confidence is not None and i < len(confidence):
                q = float(confidence[i])
                if math.isfinite(q):
                    item["filter_confidence"] = q
            out.append(item)
    return out


def _flash_key(item: dict[str, Any]) -> tuple[int, int, int]:
    return (
        int(item["time"].timestamp() * 1000),
        int(round(float(item["lat"]) * 10000)),
        int(round(float(item["lon"]) * 10000)),
    )


def _prune_cache(now: datetime) -> None:
    cutoff = now - timedelta(minutes=MAX_FEATURE_AGE_MIN + 2)
    for key, item in list(_flash_cache.items()):
        if item["time"] < cutoff:
            _flash_cache.pop(key, None)
    seen_cutoff = now - timedelta(hours=2)
    for pid, when in list(_seen_products.items()):
        if when < seen_cutoff:
            _seen_products.pop(pid, None)


def fetch_lfl(now: datetime) -> tuple[list[dict[str, Any]], datetime | None, list[str], int]:
    key = os.environ.get("EUMETSAT_CONSUMER_KEY", "").strip()
    secret = os.environ.get("EUMETSAT_CONSUMER_SECRET", "").strip()
    if not key or not secret:
        raise PermissionError("missing EUMETSAT_CONSUMER_KEY/EUMETSAT_CONSUMER_SECRET")

    import eumdac

    token = eumdac.AccessToken((key, secret))
    datastore = eumdac.DataStore(token)
    collection = datastore.get_collection(COLLECTION_ID)

    start = (now - timedelta(minutes=LOOKBACK_MIN)).replace(tzinfo=None)
    end = (now + timedelta(minutes=1)).replace(tzinfo=None)
    products = list(collection.search(dtstart=start, dtend=end))
    products.sort(key=lambda p: _aware(getattr(p, "sensing_start", None)))
    if not products:
        raise RuntimeError("no recent EUMETSAT LFL products found")

    product_end = max((_aware(getattr(p, "sensing_end", None)) for p in products), default=None)
    ids = [str(p) for p in products]

    unseen = [p for p in products if str(p) not in _seen_products]
    # Fresh process: bootstrap a useful Europe-wide history. Later cycles only
    # download newly appeared 10-second products and keep them in memory.
    if not _flash_cache and len(unseen) > BOOTSTRAP_PRODUCTS:
        unseen = unseen[-BOOTSTRAP_PRODUCTS:]

    downloaded = 0
    errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="prognozaepir-lfl-") as tmp:
        td = Path(tmp)
        for product in unseen:
            pid = str(product)
            try:
                path = _download_body(product, td)
                for item in _records_from_netcdf(path):
                    _flash_cache[_flash_key(item)] = item
                _seen_products[pid] = now
                downloaded += 1
            except Exception as exc:
                errors.append(f"{pid}: {type(exc).__name__}: {exc}")

    _prune_cache(now)
    if not _flash_cache and errors:
        raise RuntimeError(errors[-1])

    return list(_flash_cache.values()), product_end, ids[-12:], downloaded


def centroid(points: list[dict[str, Any]]) -> dict[str, float] | None:
    if not points:
        return None
    return {
        "lat": sum(float(p["lat"]) for p in points) / len(points),
        "lon": sum(float(p["lon"]) for p in points) / len(points),
    }


def _sample_map_points(points: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    ordered = sorted(points, key=lambda x: x["time"], reverse=True)
    truncated = len(ordered) > MAX_MAP_POINTS
    if truncated:
        step = len(ordered) / MAX_MAP_POINTS
        ordered = [ordered[min(len(ordered) - 1, int(i * step))] for i in range(MAX_MAP_POINTS)]

    out: list[dict[str, Any]] = []
    for p in ordered:
        item = {
            "lat": round(float(p["lat"]), 5),
            "lon": round(float(p["lon"]), 5),
            "time": iso(p["time"]),
            "age_min": round(float(p["age_min"]), 1),
            "distance_km": round(float(p["distance_km"]), 1),
        }
        if "filter_confidence" in p:
            try:
                q = float(p["filter_confidence"])
            except (TypeError, ValueError):
                q = math.nan
            if math.isfinite(q):
                item["filter_confidence"] = round(q, 3)
        out.append(item)
    return out, truncated


def build_features(
    records: list[dict[str, Any]],
    now: datetime,
    product_end: datetime | None,
    product_ids: list[str],
    downloaded_products: int = 0,
) -> dict[str, Any]:
    europe: list[dict[str, Any]] = []
    local: list[dict[str, Any]] = []

    for item in records:
        age_min = (now - item["time"]).total_seconds() / 60.0
        if age_min < -2 or age_min > MAX_FEATURE_AGE_MIN:
            continue

        lat, lon = float(item["lat"]), float(item["lon"])
        d = haversine_km(EPIR_LAT, EPIR_LON, lat, lon)
        enriched = {**item, "age_min": age_min, "distance_km": d}

        if EU_MIN_LAT <= lat <= EU_MAX_LAT and EU_MIN_LON <= lon <= EU_MAX_LON:
            europe.append(enriched)
        if d <= 180:
            local.append(enriched)

    radial = {
        str(radius): sum(1 for p in local if p["age_min"] <= 20 and p["distance_km"] <= radius)
        for radius in RADII_KM
    }
    time_counts = {
        str(window): sum(1 for p in local if p["age_min"] <= window and p["distance_km"] <= 80)
        for window in WINDOWS_MIN
    }

    nearest = min(local, key=lambda p: p["distance_km"], default=None)
    nearest_out = None
    if nearest is not None:
        nearest_out = {
            "distance_km": round(nearest["distance_km"], 1),
            "bearing_deg": round(bearing_deg(EPIR_LAT, EPIR_LON, nearest["lat"], nearest["lon"])),
            "age_min": round(nearest["age_min"], 1),
            "time": iso(nearest["time"]),
        }

    current10 = [p for p in local if 0 <= p["age_min"] <= 10 and p["distance_km"] <= 80]
    previous10 = [p for p in local if 10 < p["age_min"] <= 20 and p["distance_km"] <= 80]
    c1, c0 = len(current10), len(previous10)
    pct = None if c0 == 0 else round((c1 - c0) / c0 * 100.0, 1)
    trend = {
        "current_10min": c1,
        "previous_10min": c0,
        "delta": c1 - c0,
        "percent": pct,
        "label": "wzrost" if c1 >= c0 + max(2, round(c0 * .35)) else (
            "spadek" if c0 >= c1 + max(2, round(c0 * .35)) else "stabilnie"
        ),
    }

    cluster_points = [p for p in local if p["age_min"] <= 10 and p["distance_km"] <= 150]
    cen = centroid(cluster_points)
    centroid_out = None
    if cen:
        centroid_out = {
            "lat": round(cen["lat"], 4),
            "lon": round(cen["lon"], 4),
            "count": len(cluster_points),
            "distance_km": round(haversine_km(EPIR_LAT, EPIR_LON, cen["lat"], cen["lon"]), 1),
            "bearing_deg": round(bearing_deg(EPIR_LAT, EPIR_LON, cen["lat"], cen["lon"])),
        }

    old_points = [p for p in local if 10 < p["age_min"] <= 20 and p["distance_km"] <= 150]
    old_cen = centroid(old_points)
    motion = None
    if cen and old_cen and len(cluster_points) >= 2 and len(old_points) >= 2:
        shift = haversine_km(old_cen["lat"], old_cen["lon"], cen["lat"], cen["lon"])
        motion = {
            "kind": "activity-centroid-shift",
            "speed_kmh": round(min(180.0, shift * 6.0), 1),
            "direction_deg": round(bearing_deg(old_cen["lat"], old_cen["lon"], cen["lat"], cen["lon"])),
            "confidence": "low" if min(len(cluster_points), len(old_points)) < 5 else "medium",
            "note": "shift of lightning activity centroid; not a tracked storm-cell vector",
        }

    if product_end is None:
        product_age = None
        status = "ok"
    else:
        product_age = max(0.0, (now - product_end).total_seconds() / 60.0)
        status = "ok" if product_age <= 20 else "stale"

    europe20 = [p for p in europe if p["age_min"] <= 20]
    map_points, truncated = _sample_map_points(europe20)
    data_time = max((p["time"] for p in europe), default=None)
    oldest_age = max((p["age_min"] for p in europe20), default=0.0)

    return {
        "schema": "prognozaepir-lightning-features-v1",
        "updated_at": iso(now),
        "status": status,
        "source": {
            "provider": "EUMETSAT",
            "instrument": "MTG Lightning Imager",
            "product": "LI L2 Lightning Flashes (LFL)",
            "collection": COLLECTION_ID,
            "product_end": iso(product_end),
            "product_age_min": None if product_age is None else round(product_age, 1),
            "products": product_ids,
            "downloaded_products_this_cycle": downloaded_products,
            "cache_flashes": len(records),
            "note": "actual Europe-wide LFL flash positions/times; LI AFA is not used",
        },
        "point": {"name": "EPIR", "lat": EPIR_LAT, "lon": EPIR_LON},
        "map_scope": {
            "min_lat": EU_MIN_LAT,
            "max_lat": EU_MAX_LAT,
            "min_lon": EU_MIN_LON,
            "max_lon": EU_MAX_LON,
            "window_min": 20,
            "available_window_min": round(min(20.0, oldest_age), 1),
            "window_complete": oldest_age >= 19.0,
        },
        "data_time": iso(data_time),
        "flashes_considered": len(local),
        "europe_flashes_20min": len(europe20),
        "radial_counts_20min": radial,
        "time_counts_80km": time_counts,
        "nearest": nearest_out,
        "trend_80km": trend,
        "centroid": centroid_out,
        "motion": motion,
        "points": map_points,
        "points_truncated": truncated,
    }


def collect_and_write() -> dict[str, Any]:
    if not ENABLED:
        payload = disabled_payload("LIGHTNING_FEATURES_ENABLED=0")
        atomic_json(OUT, payload)
        return payload

    key = os.environ.get("EUMETSAT_CONSUMER_KEY", "").strip()
    secret = os.environ.get("EUMETSAT_CONSUMER_SECRET", "").strip()
    if not key or not secret:
        payload = disabled_payload("missing EUMETSAT API credentials")
        atomic_json(OUT, payload)
        return payload

    now = utc_now()
    try:
        records, product_end, product_ids, downloaded = fetch_lfl(now)
        payload = build_features(records, now, product_end, product_ids, downloaded)
    except Exception as exc:
        payload = {**disabled_payload(f"{type(exc).__name__}: {exc}"), "status": "error"}

    atomic_json(OUT, payload)
    return payload


def main() -> int:
    payload = collect_and_write()
    print(json.dumps({
        "status": payload.get("status"),
        "updated_at": payload.get("updated_at"),
        "counts": payload.get("radial_counts_20min"),
        "europe_flashes_20min": payload.get("europe_flashes_20min"),
        "points": len(payload.get("points") or []),
        "nearest": payload.get("nearest"),
        "downloaded_products_this_cycle": payload.get("source", {}).get("downloaded_products_this_cycle"),
        "reason": payload.get("reason"),
    }, ensure_ascii=False))
    return 0 if payload.get("status") in {"ok", "stale", "disabled"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
