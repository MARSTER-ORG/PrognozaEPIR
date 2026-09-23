#!/usr/bin/env python3
"""Mirror the central message archive to Supabase.

Supabase is the primary read archive. Normal runtime mirrors recent canonical
EPIR rows, archived neighbour observations (EPBY/EPKS/EPPW METAR/SPECI), and
the current neighbour-TAF snapshot. ``--all-history`` is reserved for one-time
or repair backfills.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "data" / "messages"
NEIGHBOR_ROOT = ARCHIVE / "neighbors"
STATE_PATH = Path(os.environ.get("SUPABASE_MIRROR_STATE", "/tmp/prognozaepir-supabase-mirror-state.json"))
URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
INGEST_TOKEN = os.environ.get("MESSAGE_INGEST_TOKEN") or os.environ.get("SUPABASE_INGEST_TOKEN", "")
ENABLED = os.environ.get("SUPABASE_INGEST_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
TIMEOUT = max(10, int(os.environ.get("SUPABASE_INGEST_TIMEOUT_SECONDS", "30")))
BATCH_SIZE = max(1, min(500, int(os.environ.get("SUPABASE_INGEST_BATCH_SIZE", "200"))))
TYPES = ("metar", "speci", "taf", "synop")
NEIGHBOR_STATIONS = ("epby", "epks", "eppw")


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
    basis = "\n".join(str(message.get(key) or "") for key in ("type", "station", "message_time", "canonical_raw", "raw"))
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def recent_day_files(lookback_days: int):
    now = datetime.now(timezone.utc)
    for offset in range(max(1, lookback_days)):
        day = now - timedelta(days=offset)
        for kind in TYPES:
            path = ARCHIVE / kind / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}.jsonl"
            if path.exists():
                yield path
        # Neighbour observations are intentionally kept as a compatibility
        # JSONL mirror, but Supabase receives them as ordinary message rows.
        for station in NEIGHBOR_STATIONS:
            path = NEIGHBOR_ROOT / station / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}.jsonl"
            if path.exists():
                yield path


def all_history_files():
    for kind in TYPES:
        root = ARCHIVE / kind
        if root.exists():
            yield from sorted(root.rglob("*.jsonl"))
    if NEIGHBOR_ROOT.exists():
        for station in NEIGHBOR_STATIONS:
            root = NEIGHBOR_ROOT / station
            if root.exists():
                yield from sorted(root.rglob("*.jsonl"))


def add_jsonl(path: Path, found: dict[str, dict]) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw_line in lines:
        if not raw_line.strip():
            continue
        try:
            item = json.loads(raw_line)
        except json.JSONDecodeError:
            # A concurrent atomic archive rewrite can briefly expose a partial
            # file through a mounted/synchronised filesystem. Next pass retries.
            continue
        if isinstance(item, dict):
            found[stable_id(item)] = item


def add_neighbor_snapshot(found: dict[str, dict]) -> int:
    payload = load_json(ARCHIVE / "taf-neighbors.json", {})
    added = 0
    for station, row in (payload.get("stations") or {}).items():
        if not isinstance(row, dict) or not row.get("raw"):
            continue
        item = dict(row)
        item.setdefault("schema", "prognozaepir-message-v1")
        item["type"] = "TAF"
        item["station"] = str(station).upper()
        item["snapshot_only"] = True
        before = len(found)
        found[stable_id(item)] = item
        added += int(len(found) > before)
    return added


def read_messages(lookback_days: int, all_history: bool = False) -> tuple[list[dict], int]:
    found: dict[str, dict] = {}
    files = all_history_files() if all_history else recent_day_files(lookback_days)
    for path in files:
        add_jsonl(path, found)
    snapshot_added = add_neighbor_snapshot(found)
    rows = sorted(found.values(), key=lambda m: (str(m.get("message_time") or ""), stable_id(m)))
    return rows, snapshot_added


def post_batch(messages: list[dict]) -> dict:
    endpoint = f"{URL}/functions/v1/message-ingest"
    body = json.dumps({"messages": messages}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = Request(endpoint, data=body, method="POST", headers={
        "content-type": "application/json",
        "x-ingest-token": INGEST_TOKEN,
        "user-agent": "PrognozaEPIR-Railway-Supabase-Mirror/1.3",
    })
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


def run(lookback_days: int, force: bool = False, all_history: bool = False) -> dict:
    started = utc_iso()
    if not ENABLED:
        return {"ok": True, "enabled": False, "started_at": started, "sent": 0, "reason": "disabled"}
    missing = [
        name
        for name, value in (
            ("SUPABASE_URL", URL),
            ("MESSAGE_INGEST_TOKEN or SUPABASE_INGEST_TOKEN", INGEST_TOKEN),
        )
        if not value
    ]
    if missing:
        return {"ok": False, "enabled": True, "started_at": started, "sent": 0, "error": f"missing env: {', '.join(missing)}"}

    state = load_json(STATE_PATH, {"schema": "prognozaepir-supabase-mirror-state-v1", "seen": []})
    seen = set(state.get("seen") or [])
    messages, snapshot_added = read_messages(lookback_days, all_history=all_history)
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
        if len(seen) > 12000:
            current_ids = [stable_id(m) for m in messages]
            seen = set(current_ids[-12000:])
        save_json(STATE_PATH, {"schema": "prognozaepir-supabase-mirror-state-v1", "updated_at": utc_iso(), "seen": sorted(seen)})

    return {
        "ok": True,
        "enabled": True,
        "mode": "all-history" if all_history else "recent",
        "started_at": started,
        "finished_at": utc_iso(),
        "scanned": len(messages),
        "snapshot_added": snapshot_added,
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
    parser.add_argument("--all-history", action="store_true")
    args = parser.parse_args()
    try:
        result = run(max(1, args.lookback_days), force=args.force, all_history=args.all_history)
    except Exception as exc:
        result = {"ok": False, "enabled": ENABLED, "finished_at": utc_iso(), "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
