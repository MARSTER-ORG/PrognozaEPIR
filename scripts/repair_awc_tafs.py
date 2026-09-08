#!/usr/bin/env python3
"""Repair current EPIR/neighbor TAF snapshots from AviationWeather.gov.

This is intentionally independent from the IMGW/PilotHub collector.  AWC rejects
undocumented query parameters, so requests are made without the cache-buster
used by browser-oriented providers.  The merge is monotonic: an older TAF can
never replace a newer snapshot already stored in data/taf/neighbors.json.

EPIR is subsequently copied by the central archive finalizer into EPIR-only TAF
history. EPBY/EPPW/EPKS remain current snapshots only.
"""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import collect_neighbor_tafs as taf

STATIONS = taf.STATIONS
OUT = taf.OUT
AWC_BASE = "https://aviationweather.gov/api/data/taf"
UA = "PrognozaEPIR/1.0 (+https://github.com/MARSTER-ORG/PrognozaEPIR)"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fetch_awc(station: str) -> tuple[str, str]:
    url = AWC_BASE + "?" + urllib.parse.urlencode({"ids": station, "format": "raw"})
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/plain,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return url, resp.read().decode("utf-8", errors="replace").strip()


def raws_for_station(text: str, station: str) -> list[str]:
    rows = taf.extract_station_tafs(text, station)
    if rows:
        return rows
    raw = taf.normalize_taf(text)
    if re.search(rf"\bTAF(?:\s+(?:AMD|COR))?\s+{re.escape(station)}\b", raw, re.I):
        return [raw]
    return []


def issue(raw: str | None) -> float:
    return taf.taf_issue_ts(raw or "") if raw else 0.0


def main() -> int:
    try:
        payload = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    except Exception:
        payload = {}

    stations = dict(payload.get("stations") or {})
    changed = False
    health: dict[str, str] = {}

    for sid in STATIONS:
        try:
            url, text = fetch_awc(sid)
            raws = raws_for_station(text, sid)
            if not raws:
                health[sid] = "no-data"
                continue
            best = max(raws, key=issue)
            best_issue = issue(best)
            prev = stations.get(sid) or {}
            prev_issue = issue(prev.get("raw"))

            # Never regress.  Equal issue time keeps IMGW/PilotHub provenance
            # if already present; AWC is an independent repair/fallback path.
            if best_issue > prev_issue or not prev.get("raw"):
                stations[sid] = {
                    "available": True,
                    "raw": best,
                    "updated_at": now_iso(),
                    "source": "AWC",
                    "source_url": url,
                }
                changed = True
                health[sid] = f"updated:{datetime.fromtimestamp(best_issue, timezone.utc).isoformat()}"
            else:
                health[sid] = f"kept-newer:{datetime.fromtimestamp(prev_issue, timezone.utc).isoformat()}"
        except Exception as exc:
            health[sid] = f"error:{type(exc).__name__}:{exc}"

    if not payload:
        payload = {
            "schema": "prognozaepir-neighbor-tafs-v3",
            "source": "AWC repair + IMGW/PilotHub collectors",
            "source_url": AWC_BASE,
        }
    payload["stations"] = stations
    if changed:
        payload["updated_at"] = now_iso()
        payload["source"] = "IMGW Aviation API + IMGW Awiacja + AWC + PilotHub/IMGW; monotonic repair"
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("AWC TAF repair updated", OUT)
    else:
        print("AWC TAF repair: no newer TAF")

    print(json.dumps({"awc_taf_repair": health}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
