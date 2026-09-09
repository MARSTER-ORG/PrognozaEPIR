#!/usr/bin/env python3
"""Collect MTG LI Lightning Flashes (LFL) and derive compact EPIR features.

This intentionally does not use LI AFA imagery. It downloads the official
EUMETSAT LI Level-2 Lightning Flashes product (EO:EUM:DAT:0691), reads actual
flash time/latitude/longitude records, and stores only aggregate features used
by the Cb nowcast.

Required environment variables:
  EUMETSAT_CONSUMER_KEY
  EUMETSAT_CONSUMER_SECRET

Optional:
  LIGHTNING_FEATURES_ENABLED=1
  EUMETSAT_COLLECTION_ID=EO:EUM:DAT:0691
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
LOOKBACK_MIN = 35
MAX_FEATURE_AGE_MIN = 25


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
            "note": "LI AFA is not used",
        },
        "point": {"name": "EPIR", "lat": EPIR_LAT, "lon": EPIR_LON},
        "radial_counts_20min": {str(r): 0 for r in RADII_KM},
        "time_counts_80km": {str(w): 0 for w in WINDOWS_MIN},
        "nearest": None,
        "trend_80km": None,
        "centroid": None,
        "motion": None,
    }


def _as_datetime(seconds_since_2000: float) -> datetime:
    return datetime(2000, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=float(seconds_since_2000))


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


def fetch_lfl(now: datetime) -> tuple[list[dict[str, Any]], datetime | None, list[str]]:
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
    products.sort(key=lambda p: getattr(p, "sensing_start", datetime.min))
    products = products[-5:]
    if not products:
        raise RuntimeError("no recent EUMETSAT LFL products found")

    records: list[dict[str, Any]] = []
    product_ids: list[str] = []
    product_end: datetime | None = None
    with tempfile.TemporaryDirectory(prefix="prognozaepir-lfl-") as tmp:
        td = Path(tmp)
        for product in products:
            product_ids.append(str(product))
            raw_end = getattr(product, "sensing_end", None)
            if isinstance(raw_end, datetime):
                if raw_end.tzinfo is None:
                    raw_end = raw_end.replace(tzinfo=timezone.utc)
                else:
                    raw_end = raw_end.astimezone(timezone.utc)
                if product_end is None or raw_end > product_end:
                    product_end = raw_end
            path = _download_body(product, td)
            records.extend(_records_from_netcdf(path))

    uniq: dict[tuple[int, int, int], dict[str, Any]] = {}
    for item in records:
        k = (
            int(item["time"].timestamp() * 1000),
            int(round(item["lat"] * 10000)),
            int(round(item["lon"] * 10000)),
        )
        uniq[k] = item
    return list(uniq.values()), product_end, product_ids


def centroid(points: list[dict[str, Any]]) -> dict[str, float] | None:
    if not points:
        return None
    lat = sum(p["lat"] for p in points) / len(points)
    lon = sum(p["lon"] for p in points) / len(points)
    return {"lat": lat, "lon": lon}


def build_features(records: list[dict[str, Any]], now: datetime, product_end: datetime | None, product_ids: list[str]) -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    for item in records:
        age_min = (now - item["time"]).total_seconds() / 60.0
        if age_min < -2 or age_min > MAX_FEATURE_AGE_MIN:
            continue
        d = haversine_km(EPIR_LAT, EPIR_LON, item["lat"], item["lon"])
        if d > 180:
            continue
        candidates.append({**item, "age_min": age_min, "distance_km": d})

    radial: dict[str, int] = {}
    for radius in RADII_KM:
        radial[str(radius)] = sum(1 for p in candidates if p["age_min"] <= 20 and p["distance_km"] <= radius)

    time_counts: dict[str, int] = {}
    for window in WINDOWS_MIN:
        time_counts[str(window)] = sum(1 for p in candidates if p["age_min"] <= window and p["distance_km"] <= 80)

    nearest = min(candidates, key=lambda p: p["distance_km"], default=None)
    nearest_out = None
    if nearest is not None:
        nearest_out = {
            "distance_km": round(nearest["distance_km"], 1),
            "bearing_deg": round(bearing_deg(EPIR_LAT, EPIR_LON, nearest["lat"], nearest["lon"])),
            "age_min": round(nearest["age_min"], 1),
            "time": iso(nearest["time"]),
        }

    current10 = [p for p in candidates if 0 <= p["age_min"] <= 10 and p["distance_km"] <= 80]
    previous10 = [p for p in candidates if 10 < p["age_min"] <= 20 and p["distance_km"] <= 80]
    c1, c0 = len(current10), len(previous10)
    pct = None if c0 == 0 else round((c1 - c0) / c0 * 100.0, 1)
    trend = {
        "current_10min": c1,
        "previous_10min": c0,
        "delta": c1 - c0,
        "percent": pct,
        "label": "wzrost" if c1 >= c0 + max(2, round(c0 * .35)) else ("spadek" if c0 >= c1 + max(2, round(c0 * .35)) else "stabilnie"),
    }

    cluster_points = [p for p in candidates if p["age_min"] <= 10 and p["distance_km"] <= 150]
    cen = centroid(cluster_points)
    centroid_out = None
    if cen:
        centroid_out = {
            **{k: round(v, 4) for k, v in cen.items()},
            "count": len(cluster_points),
            "distance_km": round(haversine_km(EPIR_LAT, EPIR_LON, cen["lat"], cen["lon"]), 1),
            "bearing_deg": round(bearing_deg(EPIR_LAT, EPIR_LON, cen["lat"], cen["lon"])),
        }

    old_points = [p for p in candidates if 10 < p["age_min"] <= 20 and p["distance_km"] <= 150]
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

    data_time = max((p["time"] for p in candidates), default=None)
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
            "products": product_ids[-5:],
            "note": "actual LFL flash positions/times; LI AFA is not used",
        },
        "point": {"name": "EPIR", "lat": EPIR_LAT, "lon": EPIR_LON},
        "data_time": iso(data_time),
        "flashes_considered": len(candidates),
        "radial_counts_20min": radial,
        "time_counts_80km": time_counts,
        "nearest": nearest_out,
        "trend_80km": trend,
        "centroid": centroid_out,
        "motion": motion,
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
        records, product_end, product_ids = fetch_lfl(now)
        payload = build_features(records, now, product_end, product_ids)
    except Exception as exc:
        payload = {
            **disabled_payload(f"{type(exc).__name__}: {exc}"),
            "status": "error",
        }
    atomic_json(OUT, payload)
    return payload


def main() -> int:
    payload = collect_and_write()
    print(json.dumps({
        "status": payload.get("status"),
        "updated_at": payload.get("updated_at"),
        "counts": payload.get("radial_counts_20min"),
        "nearest": payload.get("nearest"),
        "reason": payload.get("reason"),
    }, ensure_ascii=False))
    return 0 if payload.get("status") in {"ok", "stale", "disabled"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
