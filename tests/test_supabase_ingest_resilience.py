#!/usr/bin/env python3
"""Offline contract tests for retryable Supabase ingest timeouts."""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "supabase_message_mirror_retry_test", ROOT / "scripts" / "supabase_message_mirror.py"
)
assert spec and spec.loader
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)
mirror.URL = "https://test.supabase.co"
mirror.INGEST_TOKEN = "local-test-token"
mirror.time.sleep = lambda _: None


class Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return b'{"ok":true,"inserted":1,"duplicates":0}'


def record(index):
    return {
        "type": "METAR", "station": "EPIR",
        "canonical_raw": f"METAR EPIR {index:06d}Z 24004KT CAVOK",
    }


def fail(req, code):
    raise HTTPError(req.full_url, code, "test", {}, io.BytesIO(b'{"ok":false,"error":"database write failed"}'))


def main():
    calls = []

    def congested(req, _timeout):
        n = len(json.loads(req.data)["messages"])
        calls.append(n)
        if n > 1:
            fail(req, 500)
        return Response()

    mirror.urlopen = congested
    result = mirror.post_batch([record(1), record(2), record(3), record(4)])
    assert result == {"ok": True, "inserted": 4, "duplicates": 0}
    assert calls == [4, 4, 2, 2, 1, 1, 2, 2, 1, 1], calls

    calls.clear()

    def unauthorized(req, _timeout):
        calls.append(1)
        fail(req, 401)

    mirror.urlopen = unauthorized
    try:
        mirror.post_batch([record(5), record(6)])
    except RuntimeError as exc:
        assert "401" in str(exc)
    else:
        raise AssertionError("Unauthorized ingest must fail")
    assert len(calls) == 1, calls

    calls.clear()

    def one_transient_network_failure(req, _timeout):
        calls.append(1)
        if len(calls) == 1:
            raise URLError("temporary network outage")
        return Response()

    mirror.urlopen = one_transient_network_failure
    assert mirror.post_batch([record(7)])["ok"]
    assert len(calls) == 2
    print("Supabase ingest resilience: transient retry, bounded splitting, auth refusal OK")


if __name__ == "__main__":
    main()
