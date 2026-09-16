#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import import_historical_synop_teacher as hist


def main():
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "history.zip"
        rows = []
        for year in range(2020, 2025):
            rows.append({
                "obs_time": f"{year}-01-01T00:00:00Z",
                "raw": "AAXX 01001 12342 469// /2106 10014 21024 30070 40180 5/012 555 6//76=",
                "temperature_c": 1.4,
            })
        payload = "".join(json.dumps(row) + "\n" for row in rows)
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("nested/synop_teacher_2020_2024.jsonl", payload)

        loaded, member = hist.load_teacher(path)
        assert len(loaded) == 5
        assert member.endswith(hist.MEMBER_BASENAME)
        canonical = [hist.canonicalize(row, f"fixture::{member}") for row in loaded]
        assert all(canonical)
        assert {row["type"] for row in canonical} == {"SYNOP"}
        assert {row["station"] for row in canonical} == {"12342"}
        assert {row["message_time"][:4] for row in canonical} == {"2020", "2021", "2022", "2023", "2024"}
        assert all(row["source"] == hist.SOURCE_NAME for row in canonical)
        assert all(row["message_id"] for row in canonical)
        assert all(row["canonical_raw"].startswith("AAXX ") for row in canonical)

    bad = {
        "obs_time": "2025-01-01T00:00:00Z",
        "raw": "AAXX 01001 12342 469// /2106 10014 21024 30070 40180 5/012 555 6//76=",
    }
    try:
        hist.canonicalize(bad, "fixture")
    except RuntimeError:
        pass
    else:
        raise AssertionError("2025 row must not enter the 2020-2024 teacher import")

    print("historical SYNOP teacher import tests: OK")


if __name__ == "__main__":
    main()
