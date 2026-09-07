#!/usr/bin/env python3
from __future__ import annotations

import html
import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

STATIONS = ("EPBY", "EPPW", "EPKS")
OUT = Path("data/taf/neighbors.json")
AWC_URL = "https://aviationweather.gov/api/data/taf?" + urllib.parse.urlencode({
    "ids": ",".join(STATIONS),
    "format": "raw",
})
# AWC does not always carry military Polish TAFs. PilotHub exposes IMGW-fed
# aviation weather, so it is used only as a fallback for a station missing
# from the AWC response.
PILOTHUB_PAGES = {
    "EPBY": (
        "https://pilothub.pl/lotniska/epby",
    ),
    "EPPW": (
        "https://pilothub.pl/lotniska/eppw",
        "https://pilothub.pl/lotniska/szklarka-przygodzicka-ladowisko-nieewidencjonowane",
    ),
    "EPKS": (
        "https://pilothub.pl/lotniska/epks",
        "https://pilothub.pl/lotniska/epze",
    ),
}
UA = "PrognozaEPIR/0.2 (+https://github.com/MARSTER-ORG/PrognozaEPIR)"


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fetch_text(url: str, accept: str = "text/plain") -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", errors="replace").strip()


def normalize_taf(raw: str) -> str:
    raw = html.unescape(raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    raw = re.sub(r"\s*=\s*$", "=", raw)
    if raw and not raw.endswith("="):
        raw += "="
    return raw


def split_tafs(text: str) -> dict[str, str]:
    one = re.sub(r"\s+", " ", text).strip()
    pat = re.compile(r"\bTAF(?:\s+(?:AMD|COR))?\s+(EPBY|EPPW|EPKS)\b")
    matches = list(pat.finditer(one))
    out: dict[str, str] = {}
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(one)
        raw = normalize_taf(one[m.start():end])
        out[m.group(1)] = raw
    return out


def extract_station_taf(page: str, station: str) -> str | None:
    # Convert the page to plain text first. This avoids HTML tags splitting a
    # TAF group and makes the extraction independent of PilotHub styling.
    plain = html.unescape(page)
    plain = re.sub(r"<script\b[^>]*>.*?</script>", " ", plain, flags=re.I | re.S)
    plain = re.sub(r"<style\b[^>]*>.*?</style>", " ", plain, flags=re.I | re.S)
    plain = re.sub(r"<[^>]+>", " ", plain)
    plain = re.sub(r"\s+", " ", plain)
    m = re.search(
        rf"\bTAF(?:\s+(?:AMD|COR))?\s+{re.escape(station)}\b.*?=",
        plain,
        flags=re.I | re.S,
    )
    return normalize_taf(m.group(0)) if m else None


def fetch_pilothub_taf(station: str) -> tuple[str | None, str | None]:
    for url in PILOTHUB_PAGES.get(station, ()):
        try:
            page = fetch_text(url, "text/html")
            raw = extract_station_taf(page, station)
            if raw:
                return raw, url
        except Exception as exc:
            print(f"PilotHub {station} failed at {url}: {exc}")
    return None, None


def load_existing() -> dict:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        return {}


def main() -> int:
    old = load_existing()
    found: dict[str, str] = {}
    source_for: dict[str, str] = {}
    source_url_for: dict[str, str] = {}

    try:
        found.update(split_tafs(fetch_text(AWC_URL)))
        for sid in found:
            source_for[sid] = "AWC"
            source_url_for[sid] = "https://aviationweather.gov/api/data/taf"
    except Exception as exc:
        print("AWC neighbor TAF request failed:", exc)

    for sid in STATIONS:
        if sid in found:
            continue
        raw, url = fetch_pilothub_taf(sid)
        if raw:
            found[sid] = raw
            source_for[sid] = "PilotHub / IMGW"
            source_url_for[sid] = url or "https://pilothub.pl/"

    if not found:
        raise SystemExit("No matching neighbor TAFs from AWC or PilotHub")

    old_st = old.get("stations") or {}
    new_st = {}
    changed = False
    for sid in STATIONS:
        raw = found.get(sid)
        prev = old_st.get(sid) or {}
        if raw:
            prev_raw = prev.get("raw")
            stamp = prev.get("updated_at") if raw == prev_raw else utcnow_iso()
            new_st[sid] = {
                "available": True,
                "raw": raw,
                "updated_at": stamp,
                "source": source_for.get(sid),
                "source_url": source_url_for.get(sid),
            }
            changed |= raw != prev_raw or prev.get("source") != source_for.get(sid)
        elif prev.get("raw"):
            # Keep the last valid TAF through a transient source outage, but
            # preserve its timestamp so the UI can identify stale context.
            new_st[sid] = prev
        else:
            new_st[sid] = {
                "available": False,
                "raw": None,
                "updated_at": None,
                "source": None,
                "source_url": None,
            }

    payload = {
        "schema": "prognozaepir-neighbor-tafs-v1",
        "source": "AWC + PilotHub/IMGW fallback",
        "source_url": "https://aviationweather.gov/api/data/taf",
        "stations": new_st,
        "updated_at": utcnow_iso() if changed or not old.get("updated_at") else old.get("updated_at"),
    }

    if old:
        comparable_old = {k: old.get(k) for k in ("schema", "source", "source_url", "stations")}
        comparable_new = {k: payload.get(k) for k in ("schema", "source", "source_url", "stations")}
        if comparable_old == comparable_new:
            print("Neighbor TAFs unchanged")
            return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Updated", OUT)
    for sid in STATIONS:
        row = new_st[sid]
        print(sid, row.get("source"), row.get("raw") or "NIL")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
