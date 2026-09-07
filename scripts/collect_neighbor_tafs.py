#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

STATIONS = ("EPBY", "EPPW", "EPKS")
OUT = Path("data/taf/neighbors.json")
URL = "https://aviationweather.gov/api/data/taf?" + urllib.parse.urlencode({
    "ids": ",".join(STATIONS),
    "format": "raw",
})
UA = "PrognozaEPIR/0.2 (+https://github.com/MARSTER-ORG/PrognozaEPIR)"


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fetch_raw() -> str:
    req = urllib.request.Request(URL, headers={"User-Agent": UA, "Accept": "text/plain"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read().decode("utf-8", errors="replace")
    return data.strip()


def split_tafs(text: str) -> dict[str, str]:
    one = re.sub(r"\s+", " ", text).strip()
    pat = re.compile(r"\bTAF(?:\s+(?:AMD|COR))?\s+(EPBY|EPPW|EPKS)\b")
    matches = list(pat.finditer(one))
    out: dict[str, str] = {}
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(one)
        raw = one[m.start():end].strip()
        raw = re.sub(r"\s*=\s*$", "=", raw)
        if not raw.endswith("="):
            raw += "="
        out[m.group(1)] = raw
    return out


def load_existing() -> dict:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        return {}


def main() -> int:
    old = load_existing()
    text = fetch_raw()
    found = split_tafs(text)
    if not found:
        raise SystemExit("AWC returned no matching neighbor TAFs")

    old_st = old.get("stations") or {}
    new_st = {}
    changed = False
    for sid in STATIONS:
        raw = found.get(sid)
        if raw:
            prev_raw = (old_st.get(sid) or {}).get("raw")
            stamp = (old_st.get(sid) or {}).get("updated_at") if raw == prev_raw else utcnow_iso()
            new_st[sid] = {"available": True, "raw": raw, "updated_at": stamp}
            changed |= raw != prev_raw
        elif sid in old_st:
            new_st[sid] = old_st[sid]
        else:
            new_st[sid] = {"available": False, "raw": None, "updated_at": None}

    payload = {
        "schema": "prognozaepir-neighbor-tafs-v1",
        "source": "Aviation Weather Center Data API",
        "source_url": "https://aviationweather.gov/api/data/taf",
        "stations": new_st,
        "updated_at": utcnow_iso() if changed or not old.get("updated_at") else old.get("updated_at"),
    }

    # Avoid pointless commits/deploys when all raw TAFs are unchanged.
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
        print(sid, new_st[sid].get("raw") or "NIL")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
