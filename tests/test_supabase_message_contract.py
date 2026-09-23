#!/usr/bin/env python3
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "supabase_message_mirror.py"


def load_mirror():
    spec = importlib.util.spec_from_file_location("supabase_message_mirror_contract_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def fixture():
    canonical = "METAR EPIR 231200Z 24008KT 9999 BKN025 18/12 Q1018="
    identity = hashlib.sha256(f"METAR\nEPIR\n{canonical}".encode()).hexdigest()
    return {
        "schema": "prognozaepir-message-v1",
        "message_id": identity,
        "type": "METAR",
        "station": "EPIR",
        "message_time": "2026-09-23T12:00:00Z",
        "obs_time": "2026-09-23T12:00:00Z",
        "raw": "EPIR 231200Z 24008KT 9999 BKN025 18/12 Q1018=",
        "canonical_raw": canonical,
    }


class FakeResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return b'{"ok":true,"inserted":1,"duplicates":0}'


def main() -> int:
    mirror = load_mirror()
    captured = {}

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return FakeResponse()

    mirror.URL = "https://contract-test.supabase.co"
    mirror.INGEST_TOKEN = "contract-test-token"
    mirror.urlopen = fake_urlopen
    result = mirror.post_batch([fixture()])

    request = captured["request"]
    body = json.loads(request.data.decode("utf-8"))
    assert result == {"ok": True, "inserted": 1, "duplicates": 0}
    assert request.full_url.endswith("/functions/v1/message-ingest")
    assert request.get_header("X-ingest-token") == "contract-test-token"
    assert list(body) == ["messages"]
    assert body["messages"] == [fixture()]

    migration = (ROOT / "supabase" / "migrations" / "20260923171744_create_message_archive_contract.sql").read_text(encoding="utf-8")
    ingest = (ROOT / "supabase" / "functions" / "message-ingest" / "index.ts").read_text(encoding="utf-8")
    reader = (ROOT / "supabase" / "functions" / "message-archive" / "index.ts").read_text(encoding="utf-8")
    assert "create table if not exists public.messages" in migration
    assert "create table if not exists public.stations" in migration
    assert "create or replace function public.ingest_message_batch" in migration
    assert "database.rpc('ingest_message_batch'" in ingest
    assert "db.from('messages').select(SELECT)" in reader
    print("Supabase mirror -> ingest -> messages -> archive contract test passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
