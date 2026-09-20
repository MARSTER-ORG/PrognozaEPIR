#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.archive_jsonl_merge import merge_jsonl_bytes  # noqa: E402


def encoded(*rows: dict) -> bytes:
    return ("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n").encode()


def decoded(data: bytes) -> list[dict]:
    return [json.loads(line) for line in data.decode().splitlines() if line.strip()]


def test_source_gap_is_preserved_and_new_row_is_added() -> None:
    durable = encoded(
        {"message_id": "A", "raw": "A"},
        {"message_id": "B", "raw": "B"},
        {"message_id": "C", "raw": "C"},
    )
    incoming = encoded(
        {"message_id": "A", "raw": "A"},
        {"message_id": "B", "raw": "B"},
        {"message_id": "D", "raw": "D"},
    )

    merged, stats = merge_jsonl_bytes(durable, incoming)

    assert [row["message_id"] for row in decoded(merged)] == ["A", "B", "C", "D"]
    assert stats.preserved_missing_rows == 1
    assert stats.added_rows == 1
    assert stats.conflicting_rows == 0


def test_conflicting_incoming_payload_cannot_rewrite_durable_row() -> None:
    durable = encoded({"message_id": "A", "raw": "ORIGINAL", "source": "durable"})
    incoming = encoded({"message_id": "A", "raw": "CHANGED", "source": "railway"})

    merged, stats = merge_jsonl_bytes(durable, incoming)

    assert decoded(merged) == [{"message_id": "A", "raw": "ORIGINAL", "source": "durable"}]
    assert stats.conflicting_rows == 1
    assert stats.added_rows == 0


def test_fallback_identity_deduplicates_rows_without_message_id() -> None:
    durable = encoded({"type": "METAR", "station": "EPIR", "canonical_raw": "EPIR 101200Z"})
    incoming = encoded({"type": "METAR", "station": "EPIR", "canonical_raw": "EPIR 101200Z"})

    merged, stats = merge_jsonl_bytes(durable, incoming)

    assert len(decoded(merged)) == 1
    assert stats.added_rows == 0
    assert stats.preserved_missing_rows == 0


if __name__ == "__main__":
    test_source_gap_is_preserved_and_new_row_is_added()
    test_conflicting_incoming_payload_cannot_rewrite_durable_row()
    test_fallback_identity_deduplicates_rows_without_message_id()
    print("archive_jsonl_merge tests: OK")
