#!/usr/bin/env python3
"""Append-only JSONL merge for the durable message archive.

Railway is the live acquisition source, while GitHub is a durable mirror. A live
snapshot may occasionally be built from an older deployment image and therefore
omit a record that is already durable in GitHub. The mirror must never turn that
source gap into data loss.

The merge policy is deliberately conservative:
- keep the first durable row for every stable message identity;
- append only identities that are new in the incoming snapshot;
- if the same identity has different JSON payloads, keep the durable payload and
  report a conflict instead of silently rewriting history;
- preserve deterministic durable-first ordering.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class MergeStats:
    durable_rows: int
    incoming_rows: int
    result_rows: int
    added_rows: int
    preserved_missing_rows: int
    conflicting_rows: int
    duplicate_rows: int

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


def _canonical_payload(row: dict) -> str:
    return json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def message_identity(row: dict) -> str:
    ident = str(row.get("message_id") or "").strip()
    if ident:
        return "id:" + ident
    material = "|".join(
        [
            str(row.get("type") or ""),
            str(row.get("station") or ""),
            str(row.get("canonical_raw") or row.get("raw") or ""),
        ]
    )
    return "fallback:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def _rows(data: bytes, label: str) -> list[tuple[str, str, str]]:
    parsed: list[tuple[str, str, str]] = []
    for line_no, raw in enumerate(data.decode("utf-8").splitlines(), start=1):
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{label} line {line_no}: invalid JSON: {exc}") from exc
        if not isinstance(row, dict):
            raise ValueError(f"{label} line {line_no}: JSONL row is not an object")
        parsed.append((message_identity(row), raw, _canonical_payload(row)))
    return parsed


def merge_jsonl_bytes(durable: bytes, incoming: bytes) -> tuple[bytes, MergeStats]:
    """Return an append-only union of durable and incoming JSONL snapshots."""
    durable_rows = _rows(durable, "durable")
    incoming_rows = _rows(incoming, "incoming")

    output: list[str] = []
    payload_by_id: dict[str, str] = {}
    durable_ids: set[str] = set()
    incoming_ids: set[str] = set()
    conflicts = 0
    duplicates = 0
    added = 0

    for ident, raw, payload in durable_rows:
        if ident in payload_by_id:
            duplicates += 1
            if payload_by_id[ident] != payload:
                conflicts += 1
            continue
        payload_by_id[ident] = payload
        durable_ids.add(ident)
        output.append(raw)

    for ident, raw, payload in incoming_rows:
        incoming_ids.add(ident)
        if ident in payload_by_id:
            duplicates += 1
            if payload_by_id[ident] != payload:
                conflicts += 1
            continue
        payload_by_id[ident] = payload
        output.append(raw)
        added += 1

    encoded = (("\n".join(output) + "\n") if output else "").encode("utf-8")
    stats = MergeStats(
        durable_rows=len(durable_rows),
        incoming_rows=len(incoming_rows),
        result_rows=len(output),
        added_rows=added,
        preserved_missing_rows=len(durable_ids - incoming_ids),
        conflicting_rows=conflicts,
        duplicate_rows=duplicates,
    )
    return encoded, stats
