#!/usr/bin/env python3
"""Persist the latest MTG LI snapshot and collector cache in Supabase.

The public lightning JSON is served by the Supabase Edge Function
`lightning-latest`. Railway cron restores the previous collector state before
each run and publishes the refreshed state afterwards, so short-lived cron
containers do not have to rebuild the whole LFL lookback window every 5 minutes.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
LIGHTNING_PATH = ROOT / "data" / "lightning" / "latest.json"
CACHE_PATH = Path(os.environ.get("LFL_PERSIST_CACHE", "/tmp/prognozaepir-lfl-cache.json"))
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
INGEST_TOKEN = os.environ.get("MESSAGE_INGEST_TOKEN") or os.environ.get("SUPABASE_INGEST_TOKEN", "")
TIMEOUT = max(10, int(os.environ.get("SUPABASE_LIGHTNING_TIMEOUT_SECONDS", "30")))


def endpoint() -> str:
    if not SUPABASE_URL:
        raise RuntimeError("missing SUPABASE_URL")
    if not INGEST_TOKEN:
        raise RuntimeError("missing MESSAGE_INGEST_TOKEN or SUPABASE_INGEST_TOKEN")
    return f"{SUPABASE_URL}/functions/v1/lightning-ingest"


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def request_json(method: str, payload: dict | None = None) -> dict:
    data = None
    headers = {
        "accept": "application/json",
        "x-ingest-token": INGEST_TOKEN,
        "user-agent": "PrognozaEPIR-Railway-Lightning-Mirror/1.0",
    }
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["content-type"] = "application/json"
    request = Request(endpoint(), data=data, method=method, headers=headers)
    try:
        with urlopen(request, timeout=TIMEOUT) as response:
            body = response.read().decode("utf-8", errors="replace")
            parsed = json.loads(body) if body else {}
            if response.status < 200 or response.status >= 300 or not parsed.get("ok"):
                raise RuntimeError(f"Supabase lightning HTTP {response.status}: {parsed}")
            return parsed
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase lightning HTTP {exc.code}: {detail[:500]}") from exc
    except URLError as exc:
        raise RuntimeError(f"Supabase lightning network error: {exc.reason}") from exc


def restore() -> dict:
    result = request_json("GET")
    if not result.get("found"):
        return {"ok": True, "restored": False, "reason": "no-remote-state"}

    payload = result.get("payload")
    if not isinstance(payload, dict) or payload.get("schema") != "prognozaepir-lightning-features-v1":
        raise RuntimeError("remote lightning payload has unexpected schema")
    atomic_json(LIGHTNING_PATH, payload)

    collector_state = result.get("collector_state")
    cache_restored = False
    if isinstance(collector_state, dict):
        atomic_json(CACHE_PATH, collector_state)
        cache_restored = True

    return {
        "ok": True,
        "restored": True,
        "cache_restored": cache_restored,
        "remote_updated_at": result.get("updated_at"),
    }


def publish() -> dict:
    payload = load_json(LIGHTNING_PATH)
    if not isinstance(payload, dict) or payload.get("schema") != "prognozaepir-lightning-features-v1":
        raise RuntimeError("local lightning payload is missing or has unexpected schema")
    collector_state = load_json(CACHE_PATH)
    body = {"payload": payload}
    if isinstance(collector_state, dict):
        body["collector_state"] = collector_state
    result = request_json("POST", body)
    return {
        "ok": True,
        "published": True,
        "cache_published": isinstance(collector_state, dict),
        "remote_updated_at": result.get("updated_at"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("restore", "publish"))
    args = parser.parse_args()
    try:
        result = restore() if args.action == "restore" else publish()
    except Exception as exc:
        result = {"ok": False, "action": args.action, "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
