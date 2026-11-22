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
import time
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
BATCH_SIZE = max(1, min(500, int(os.environ.get("SUPABASE_INGEST_BATCH_SIZE", "50"))))
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


def canonical_identity(message: dict) -> str | None:
    """Return the identity required by the message-ingest contract.

    Historical local rows may carry a pre-contract ``message_id``. Supabase
    validates identity as SHA-256(TYPE + station + canonical_raw), after
    upper-casing type/station and trimming canonical_raw. Recompute that exact
    identity here instead of trusting a possibly stale stored identifier.
    """
    message_type = str(message.get("type") or "").strip().upper()
    station = str(message.get("station") or "").strip().upper()
    canonical_raw = str(message.get("canonical_raw") or "").strip()
    if not message_type or not station or not canonical_raw:
        return None
    basis = f"{message_type}\n{station}\n{canonical_raw}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def stable_id(message: dict) -> str:
    canonical_id = canonical_identity(message)
    if canonical_id:
        return canonical_id
    mid = str(message.get("message_id") or "").strip().lower()
    if mid:
        return mid
    basis = "\n".join(str(message.get(key) or "") for key in ("type", "station", "message_time", "canonical_raw", "raw"))
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def prepare_for_ingest(message: dict) -> dict:
    """Canonicalize outbound identity without mutating the local archive row."""
    message_type = str(message.get("type") or "").strip().upper()
    station = str(message.get("station") or "").strip().upper()
    canonical_raw = str(message.get("canonical_raw") or "").strip()
    if not message_type or not station or not canonical_raw:
        raise ValueError("message is missing canonical identity fields: type, station or canonical_raw")
    item = dict(message)
    item["type"] = message_type
    item["station"] = station
    item["canonical_raw"] = canonical_raw
    item["message_id"] = canonical_identity(item)
    return item


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


def _post_batch_once(messages: list[dict]) -> dict:
    """One atomic request. A failed request never changes the local checkpoint."""
    endpoint = f"{URL}/functions/v1/message-ingest"
    outbound = [prepare_for_ingest(message) for message in messages]
    body = json.dumps({"messages": outbound}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = Request(endpoint, data=body, method="POST", headers={
        "content-type": "application/json",
        "x-ingest-token": INGEST_TOKEN,
        "user-agent": "PrognozaEPIR-Railway-Supabase-Mirror/1.5",
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
        error = RuntimeError(f"Supabase ingest HTTP {exc.code}: {detail[:500]}")
        # 401/403/409/422 etc. require correction, not a retry storm.
        error.retryable = exc.code in (408, 429, 500, 502, 503, 504)
        raise error from exc
    except (URLError, TimeoutError, OSError) as exc:
        error = RuntimeError(f"Supabase ingest network error: {exc}")
        error.retryable = True
        raise error from exc


def post_batch(messages: list[dict], *, _split_depth: int = 0) -> dict:
    """Retry transient 5xx/SQL timeouts; split overloaded RPC batches safely.

    Supabase's ingest contract deduplicates canonical message identity. This
    allows safe retries following an ambiguous gateway timeout. Checkpoints
    are advanced by run() only after the whole returned batch succeeds.
    """
    if not messages:
        return {"ok": True, "inserted": 0, "duplicates": 0}
    last_error: RuntimeError | None = None
    for attempt in range(2):
        try:
            return _post_batch_once(messages)
        except RuntimeError as exc:
            if not getattr(exc, "retryable", False):
                raise
            last_error = exc
            if attempt == 0:
                time.sleep(1.0)
    # A larger batch may exceed PostgreSQL's statement timeout (SQLSTATE
    # 57014). Reduce the per-transaction work instead of repeatedly sending
    # the same large request. At most two split levels bound network usage.
    if len(messages) > 1 and _split_depth < 2:
        midpoint = len(messages) // 2
        left = post_batch(messages[:midpoint], _split_depth=_split_depth + 1)
        right = post_batch(messages[midpoint:], _split_depth=_split_depth + 1)
        return {
            "ok": True,
            "inserted": int(left.get("inserted") or 0) + int(right.get("inserted") or 0),
            "duplicates": int(left.get("duplicates") or 0) + int(right.get("duplicates") or 0),
        }
    assert last_error is not None
    raise last_error


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
