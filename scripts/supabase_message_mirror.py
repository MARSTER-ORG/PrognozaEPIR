#!/usr/bin/env python3
"""Mirror recent central message archive rows to Supabase.

This is deliberately best-effort and isolated from the primary archive path.
The canonical JSONL archive remains authoritative during the parallel-test phase.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "data" / "messages"
STATE_PATH = Path(os.environ.get("SUPABASE_MIRROR_STATE", "/tmp/prognozaepir-supabase-mirror-state.json"))
URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
INGEST_TOKEN = os.environ.get("SUPABASE_INGEST_TOKEN", "")
ENABLED = os.environ.get("SUPABASE_INGEST_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
TIMEOUT = max(10, int(os.environ.get("SUPABASE_INGEST_TIMEOUT_SECONDS", "30")))
BATCH_SIZE = max(1, min(500, int(os.environ.get("SUPABASE_INGEST_BATCH_SIZE", "200"))))
TYPES = ("metar", "speci", "taf", "synop")


def utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def stable_id(message: dict) -> str:
    mid = str(message.get("message_id") or "").strip()
    if mid:
        return mid
    basis = "\n".join(
        str(message.get(key) or "")
        for key in ("type", "station", "message_time", "canonical_raw", "raw")
    )
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def recent_day_files(lookback_days: int):
    now = datetime.now(timezone.utc)
    for offset in range(max(1, lookback_days)):
        day = now - timedelta(days=offset)
        for kind in TYPES:
            path = ARCHIVE / kind / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}.jsonl"
            if path.exists():
                yield path


def read_messages(lookback_days: int) -> list[dict]:
    found: dict[str, dict] = {}
    for path in recent_day_files(lookback_days):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for raw_line in lines:
            if not raw_line.strip():
                continue
            try:
                item = json.loads(raw_line)
            except json.JSONDecodeError:
                # A concurrent archive rewrite can briefly expose an incomplete
                # line. The next mirror pass will retry it.
                continue
            if not isinstance(item, dict):
                continue
            found[stable_id(item)] = item
    return sorted(found.values(), key=lambda m: (str(m.get("message_time") or ""), stable_id(m)))


def post_batch(messages: list[dict]) -> dict:
    endpoint = f"{URL}/functions/v1/message-ingest"
    body = json.dumps({"messages": messages}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {ANON_KEY}",
            "apikey": ANON_KEY,
            "x-ingest-token": INGEST_TOKEN,
            "user-agent": "PrognozaEPIR-Railway-Supabase-Mirror/1.0",
        },
    )
    try:
        with urlopen(request, timeout=TIMEOUT) as response:
            payload = response.read().decode("utf-8", errors="replace")
            parsed = json.loads(payload) if payload else {}
            if response.status < 200 or response.status >= 300 or not parsed.get("ok"):
                raise RuntimeError(f"Supabase ingest HTTP {response.status}: {parsed}")
            return parsed
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase ingest HTTP {exc.code}: {detail[:500]}") from exc
    except URLError as exc:
        raise RuntimeError(f"Supabase ingest network error: {exc.reason}") from exc


def run(lookback_days: int, force: bool = False) -> dict:
    started = utc_iso()
    if not ENABLED:
        return {"ok": True, "enabled": False, "started_at": started, "sent": 0, "reason": "disabled"}
    missing = [name for name, value in (("SUPABASE_URL", URL), ("SUPABASE_ANON_KEY", ANON_KEY), ("SUPABASE_INGEST_TOKEN", INGEST_TOKEN)) if not value]
    if missing:
        return {"ok": False, "enabled": True, "started_at": started, "sent": 0, "error": f"missing env: {', '.join(missing)}"}

    state = load_json(STATE_PATH, {"schema": "prognozaepir-supabase-mirror-state-v1", "seen": []})
    seen = set(state.get("seen") or [])
    messages = read_messages(lookback_days)
    pending = messages if force else [m for m in messages if stable_id(m) not in seen]

    sent = inserted = duplicates = 0
    for idx in range(0, len(pending), BATCH_SIZE):
        batch = pending[idx:idx + BATCH_SIZE]
        result = post_batch(batch)
        sent += len(batch)
        inserted += int(result.get("inserted") or 0)
        duplicates += int(result.get("duplicates") or 0)
        for message in batch:
            seen.add(stable_id(message))
        # Keep state bounded while preserving enough restart/retry context.
        if len(seen) > 5000:
            current_ids = [stable_id(m) for m in messages]
            seen = set(current_ids[-5000:])
        save_json(STATE_PATH, {
            "schema": "prognozaepir-supabase-mirror-state-v1",
            "updated_at": utc_iso(),
            "seen": sorted(seen),
        })

    return {
        "ok": True,
        "enabled": True,
        "started_at": started,
        "finished_at": utc_iso(),
        "scanned": len(messages),
        "pending": len(pending),
        "sent": sent,
        "inserted": inserted,
        "duplicates": duplicates,
        "state_path": str(STATE_PATH),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lookback-days", type=int, default=int(os.environ.get("SUPABASE_INGEST_LOOKBACK_DAYS", "3")))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    try:
        result = run(max(1, args.lookback_days), force=args.force)
    except Exception as exc:
        result = {"ok": False, "enabled": ENABLED, "finished_at": utc_iso(), "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
