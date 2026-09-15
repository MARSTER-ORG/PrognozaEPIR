#!/usr/bin/env python3
"""Canonical censored-event reader for Fog Engine vNext.

The corrected 2020-2024 package is authoritative for historical event
boundaries.  Header matching is semantic rather than position-based so the
loader can audit the real CSV schema in CI without duplicating the dataset in
the repository.  Start/end fields are mandatory.  At least one censoring field
must be identifiable; otherwise the load fails loudly instead of silently
turning censored onset/exit into exact timestamps.
"""
from __future__ import annotations

import csv
import io
import re
import zipfile
from pathlib import Path

import model_verification as mv

CSV_BASENAME = "fog_events_censored_2020_2024.csv"


def norm(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def bool_value(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "tak", "t"}:
        return True
    if text in {"0", "false", "no", "n", "nie", "f", "", "none", "null", "nan"}:
        return False
    try:
        return bool(int(float(text)))
    except Exception:
        return False


def _pick(fields, exact=(), all_tokens=(), any_tokens=(), forbidden=(), required=True):
    mapping = {norm(f): f for f in fields}
    for candidate in exact:
        if norm(candidate) in mapping:
            return mapping[norm(candidate)]
    matches = []
    for field in fields:
        n = norm(field)
        if forbidden and any(norm(t) in n for t in forbidden):
            continue
        if all_tokens and not all(norm(t) in n for t in all_tokens):
            continue
        if any_tokens and not any(norm(t) in n for t in any_tokens):
            continue
        matches.append(field)
    if len(matches) == 1:
        return matches[0]
    if matches:
        # Prefer the shortest semantic match; verbose derived/diagnostic columns
        # tend to have extra suffixes.
        return sorted(matches, key=lambda f: (len(norm(f)), norm(f)))[0]
    if required:
        raise RuntimeError(f"cannot resolve required field from headers: {fields}")
    return None


def resolve_schema(fields):
    fields = list(fields or [])
    if not fields:
        raise RuntimeError("censored-event CSV has no header")
    start = _pick(
        fields,
        exact=("event_start", "start", "start_time", "event_start_utc", "start_utc", "start_dt"),
        all_tokens=("start",),
        forbidden=("censor", "hour", "month", "state"),
    )
    end = _pick(
        fields,
        exact=("event_end", "end", "end_time", "event_end_utc", "end_utc", "end_dt"),
        all_tokens=("end",),
        forbidden=("censor", "hour", "month", "state"),
    )
    event_id = _pick(
        fields,
        exact=("event_id", "eventid", "id"),
        all_tokens=("event", "id"),
        required=False,
    )

    left = _pick(
        fields,
        exact=(
            "left_censored", "left_censored_onset", "onset_left_censored",
            "fog_onset_left_censored", "left_censor", "onset_censored",
        ),
        all_tokens=("left", "censor"),
        required=False,
    )
    if left is None:
        left = _pick(
            fields,
            all_tokens=("onset", "censor"),
            forbidden=("right", "end", "dissip"),
            required=False,
        )

    right = _pick(
        fields,
        exact=(
            "right_censored", "right_censored_end", "end_right_censored",
            "fog_end_right_censored", "right_censor", "dissipation_censored",
        ),
        all_tokens=("right", "censor"),
        required=False,
    )
    if right is None:
        right = _pick(
            fields,
            all_tokens=("censor",),
            any_tokens=("end", "dissip", "exit"),
            forbidden=("left", "onset"),
            required=False,
        )

    if left is None and right is None:
        censor_fields = [f for f in fields if "censor" in norm(f)]
        raise RuntimeError(
            "canonical censored-event CSV exposes no identifiable censor flag; "
            f"censor-like fields={censor_fields}, headers={fields}"
        )
    return {
        "event_id": event_id,
        "start": start,
        "end": end,
        "left_censored": left,
        "right_censored": right,
        "headers": fields,
    }


def load(path):
    path = Path(path)
    if not path.exists():
        return [], None
    with zipfile.ZipFile(path) as zf:
        matches = [name for name in zf.namelist() if Path(name).name == CSV_BASENAME]
        if len(matches) != 1:
            raise RuntimeError(f"expected exactly one {CSV_BASENAME}, got {matches}")
        text = zf.read(matches[0]).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    schema = resolve_schema(reader.fieldnames)
    out = []
    for idx, row in enumerate(reader, 1):
        start = mv.parse_dt(row.get(schema["start"]))
        end = mv.parse_dt(row.get(schema["end"]))
        if not start or not end:
            raise RuntimeError(f"invalid canonical event boundary at CSV row {idx + 1}: {row}")
        if end < start:
            raise RuntimeError(f"canonical event end precedes start at CSV row {idx + 1}")
        eid = row.get(schema["event_id"]) if schema["event_id"] else None
        out.append({
            "event_id": str(eid).strip() if eid not in (None, "") else f"CAN-{start:%Y%m%dT%H%MZ}-{end:%H%MZ}",
            "start": start,
            "end": end,
            "left_censored": bool_value(row.get(schema["left_censored"])) if schema["left_censored"] else False,
            "right_censored": bool_value(row.get(schema["right_censored"])) if schema["right_censored"] else False,
            "source_row": idx + 1,
        })
    if not out:
        raise RuntimeError("canonical censored-event CSV is empty")
    years = {r["start"].year for r in out}
    if not years.issubset(set(range(2020, 2025))):
        raise RuntimeError(f"canonical censored-event table contains unexpected years: {sorted(years)}")
    return out, schema
