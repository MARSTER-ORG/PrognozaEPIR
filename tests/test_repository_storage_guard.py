#!/usr/bin/env python3
from pathlib import Path
from datetime import date
import json
import sys
import urllib.parse

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

    payload = {
        "ok": True,
        "rows": [{
            "type": "METAR",
            "archive_time": "2026-09-19T00:00:00Z",
            "canonical_raw": "METAR EPBY 190000Z 24004KT CAVOK 10/10 Q1016=",
        }],
        "count": 1,
    }
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps(payload).encode("utf-8")

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return Response()

    original_key = guard.public_anon_key
    original_urlopen = guard.urllib.request.urlopen
    try:
        guard.public_anon_key = lambda: "anon-test-key"
        guard.urllib.request.urlopen = fake_urlopen
        keys = guard.fetch_remote_keys("EPBY", date(2026, 9, 19))
    finally:
        guard.public_anon_key = original_key
        guard.urllib.request.urlopen = original_urlopen

    request = captured["request"]
    query = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
    assert request.full_url.startswith(guard.ARCHIVE_URL + "?")
    assert query["op"] == ["search"]
    assert query["station"] == ["EPBY"]
    assert request.get_header("Authorization") == "Bearer anon-test-key"
    assert keys == {("METAR", "2026-09-19T00:00:00Z", "EPBY 190000Z 24004KT CAVOK 10/10 Q1016")}

    print("repository storage guard tests OK")


if __name__ == "__main__":
    main()
