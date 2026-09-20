#!/usr/bin/env python3
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import repository_storage_guard as guard


def main():
    assert guard.storage_mode(100 * 1024, 500) == "normal"
    assert guard.storage_mode(374 * 1024, 500) == "normal"
    assert guard.storage_mode(375 * 1024, 500) == "rolling"
    assert guard.storage_mode(499 * 1024, 500) == "rolling"
    assert guard.storage_mode(500 * 1024, 500) == "external"

    assert guard.retention_days("normal") is None
    assert guard.retention_days("rolling") == 30
    assert guard.retention_days("external") == 7

    assert guard.normalize_raw("METAR EPBY 190000Z 24004KT CAVOK 10/10 Q1016=") == "EPBY 190000Z 24004KT CAVOK 10/10 Q1016"
    assert guard.normalize_raw("EPBY 190000Z 24004KT CAVOK 10/10 Q1016") == "EPBY 190000Z 24004KT CAVOK 10/10 Q1016"
    assert guard.normalize_time("2026-09-19 00:00:00+00") == "2026-09-19T00:00:00Z"

    print("repository storage guard tests OK")


if __name__ == "__main__":
    main()
