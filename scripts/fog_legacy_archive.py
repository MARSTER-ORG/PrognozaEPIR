#!/usr/bin/env python3
"""Archive and verify the canonical browser LEGACY fog forecast.

The capture itself is produced by the real frontend in headless Chrome. This
script validates/persists that snapshot and later matches issued forecasts
against archived EPIR METAR/SPECI observations. Forecasts are eligible only if
they were captured before valid time; no retrospective model reconstruction is
used for verification.
"""
from __future__ import annotations

import argparse
import bisect
import html
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import model_verification as mv

ROOT = Path(__file__).resolve().parents[1]
FORECAST_DIR = ROOT / "data" / "learning" / "fog-legacy-forecasts"
VERIFY_DIR = ROOT / "data" / "learning" / "fog-legacy-verification"
CASES_PATH = VERIFY_DIR / "cases.jsonl"
SUMMARY_PATH = VERIFY_DIR / "summary.json"
WINDOW_MIN = 35
MIN_LEAD_MIN = 15
FOG_CODES = {"FG", "MIFG", "BCFG", "PRFG", "FZFG"}
PRECIP_FRAGMENTS = ("RA", "DZ", "SN", "SG", "PL", "GR", "GS", "TS")
TARGETS = ("FG", "BR", "MIFG")


def finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def num(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def clip(v: float, a: float = 0.0, b: float = 1.0) -> float:
    return max(a, min(b, v))


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def tokens(raw: str) -> set[str]:
    return set(re.findall(r"[A-Z]{2,}", str(raw or "").upper()))


class _PayloadParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.capture = False
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        if tag.lower() == "pre" and attr.get("id") == "fogLegacyArchivePayload":
            self.capture = True
            self.depth = 1
        elif self.capture:
            self.depth += 1

    def handle_endtag(self, tag: str) -> None:
        if self.capture:
            self.depth -= 1
            if self.depth <= 0:
                self.capture = False

    def handle_data(self, data: str) -> None:
        if self.capture:
            self.parts.append(data)


def read_dom_payload(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    parser = _PayloadParser()
    parser.feed(text)
    raw = html.unescape("".join(parser.parts)).strip()
    if not raw:
        raise SystemExit("Headless capture did not publish #fogLegacyArchivePayload")
    try:
        payload = json.loads(raw)
    except Exception as exc:
        raise SystemExit(f"Invalid LEGACY capture JSON: {exc}")
    return payload


def validate_payload(payload: dict) -> tuple[datetime, list[dict]]:
    if payload.get("schema") != "prognozaepir-fog-legacy-browser-snapshot-v1":
        raise SystemExit("Unsupported LEGACY browser snapshot schema")
    run = parse_dt(payload.get("captured_at"))
    if not run:
        raise SystemExit("LEGACY capture has invalid captured_at")
    hours = payload.get("hours") or []
    if not isinstance(hours, list) or len(hours) < 6:
        raise SystemExit(f"LEGACY capture incomplete: only {len(hours) if isinstance(hours, list) else 0} hours")
    valid_rows = []
    for row in hours:
        if not isinstance(row, dict):
            continue
        valid = parse_dt(row.get("valid_time"))
        score = num(row.get("score"))
        if not valid or score is None or not (0 <= score <= 100):
            continue
        valid_rows.append(row)
    if len(valid_rows) < 6:
        raise SystemExit("LEGACY capture has too few valid score rows")
    return run, valid_rows


def append_snapshot(payload: dict) -> Path:
    run, hours = validate_payload(payload)
    payload = dict(payload)
    payload["captured_at"] = iso(run)
    payload["hours"] = hours
    slot_minute = (run.minute // 15) * 15
    slot = run.replace(minute=slot_minute, second=0, microsecond=0)
    payload["snapshot_id"] = f"legacy-{slot:%Y%m%dT%H%MZ}"
    payload["verification_contract"] = {
        "captured_from": "canonical browser LEGACY runtime",
        "future_truth_not_available_at_capture": True,
        "minimum_verification_lead_minutes": MIN_LEAD_MIN,
    }

    path = FORECAST_DIR / f"{run:%Y-%m-%d}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = mv.load_jsonl(path)
    sid = payload["snapshot_id"]
    replaced = False
    out = []
    for row in existing:
        if row.get("snapshot_id") == sid:
            if not replaced:
                out.append(payload)
                replaced = True
        else:
            out.append(row)
    if not replaced:
        out.append(payload)
    out.sort(key=lambda x: x.get("captured_at") or "")
    path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in out), encoding="utf-8")
    print(f"LEGACY snapshot archived: {sid}; hours={len(hours)}; path={path.relative_to(ROOT)}")
    return path


def obs_truth(obs: dict) -> dict:
    raw = str(obs.get("canonical_raw") or obs.get("raw") or "").upper()
    tok = tokens(raw)
    vis = num(obs.get("visibility_m"))
    precip = any(fragment in raw for fragment in PRECIP_FRAGMENTS)
    mifg = "MIFG" in tok
    explicit_fog = bool(tok & FOG_CODES) or bool(obs.get("fog")) or bool(obs.get("freezing_fog"))
    visibility_fog = vis is not None and vis < 1000 and not precip
    fg = (explicit_fog or visibility_fog) and not mifg
    explicit_br = "BR" in tok or bool(obs.get("mist"))
    # Match the operational vNext verification convention: 1-5 km without FG/MIFG
    # is a BR truth state even when an AUTO report omits the BR token.
    br_vis = vis is not None and 1000 <= vis <= 5000 and not fg and not mifg
    br = (explicit_br or br_vis) and not fg and not mifg
    fog_free = vis is not None and vis > 5000 and not fg and not br and not mifg
    if mifg:
        state = "MIFG"
    elif fg:
        state = "FG"
    elif br:
        state = "BR"
    elif fog_free:
        state = "CLEAR"
    else:
        state = "OTHER"
    return {
        "state": state,
        "FG": bool(fg),
        "BR": bool(br),
        "MIFG": bool(mifg),
        "visibility_m": vis,
        "precip": precip,
        "raw": raw,
    }


def load_observations() -> list[dict]:
    rows = []
    seen = set()
    for source, directory in (("METAR", mv.METAR_DIR), ("SPECI", mv.SPECI_DIR)):
        for row in mv.all_jsonl(directory):
            dt = parse_dt(row.get("obs_time") or row.get("message_time"))
            if not dt:
                continue
            raw = str(row.get("canonical_raw") or row.get("raw") or "")
            key = (iso(dt), raw)
            if key in seen:
                continue
            seen.add(key)
            rr = dict(row)
            rr["_dt"] = dt
            rr["_source"] = "SPECI" if source == "SPECI" or str(row.get("type") or row.get("report_type") or "").upper() == "SPECI" else "METAR"
            rr["_truth"] = obs_truth(row)
            rows.append(rr)
    rows.sort(key=lambda r: r["_dt"])
    return rows


def lead_bucket(hours: float) -> str | None:
    return mv.lead_bucket(hours)


def nearest_observation(observations: list[dict], times: list[float], valid: datetime) -> dict | None:
    if not observations:
        return None
    center = valid.timestamp()
    span = WINDOW_MIN * 60
    lo = bisect.bisect_left(times, center - span)
    hi = bisect.bisect_right(times, center + span)
    nearby = observations[lo:hi]
    if not nearby:
        return None
    # Nearest exact-time truth; SPECI wins a same-distance tie because it carries
    # the event-time aviation update.
    return min(nearby, key=lambda r: (abs((r["_dt"] - valid).total_seconds()), 0 if r["_source"] == "SPECI" else 1))


def target_probability(hour: dict, target: str) -> float | None:
    if target == "FG":
        x = num(hour.get("score"))
    elif target == "BR":
        x = num((hour.get("br") or {}).get("score"))
    elif target == "MIFG":
        x = num((hour.get("mifg") or {}).get("score"))
    else:
        x = None
    return clip(x / 100.0) if x is not None else None


def outcome(prob: float | None, truth: bool) -> str | None:
    if prob is None:
        return None
    pred = prob >= 0.50
    if pred and truth:
        return "HIT"
    if pred and not truth:
        return "FALSE_ALARM"
    if not pred and truth:
        return "MISS"
    return "CORRECT_NEGATIVE"


def load_snapshots() -> list[dict]:
    rows = []
    if FORECAST_DIR.exists():
        for p in sorted(FORECAST_DIR.glob("*.jsonl")):
            rows.extend(mv.load_jsonl(p))
    return rows


def build_cases() -> list[dict]:
    observations = load_observations()
    obs_times = [r["_dt"].timestamp() for r in observations]
    now = mv.utcnow()
    cases = []
    seen = set()
    for snap in load_snapshots():
        run = parse_dt(snap.get("captured_at"))
        sid = snap.get("snapshot_id") or snap.get("captured_at")
        if not run:
            continue
        for h in snap.get("hours") or []:
            valid = parse_dt(h.get("valid_time"))
            if not valid or valid > now:
                continue
            lead_h = (valid - run).total_seconds() / 3600.0
            if lead_h * 60 < MIN_LEAD_MIN:
                continue
            bucket = lead_bucket(lead_h)
            if not bucket:
                continue
            obs = nearest_observation(observations, obs_times, valid)
            if not obs:
                continue
            truth = obs["_truth"]
            key = (sid, iso(valid), iso(obs["_dt"]))
            if key in seen:
                continue
            seen.add(key)
            probs = {t: target_probability(h, t) for t in TARGETS}
            outcomes = {t: outcome(probs[t], bool(truth[t])) for t in TARGETS}
            case = {
                "schema": "prognozaepir-fog-legacy-verification-case-v1",
                "snapshot_id": sid,
                "run_time": iso(run),
                "valid_time": iso(valid),
                "lead_hours": round(lead_h, 3),
                "lead_bucket": bucket,
                "observation": {
                    "time": iso(obs["_dt"]),
                    "source": obs["_source"],
                    "state": truth["state"],
                    "visibility_m": truth["visibility_m"],
                    "raw": truth["raw"][:240],
                },
                "forecast": {
                    "fg_score": num(h.get("score")),
                    "br_score": num((h.get("br") or {}).get("score")),
                    "mifg_score": num((h.get("mifg") or {}).get("score")),
                    "predicted_visibility_m": num(h.get("predicted_visibility_m")),
                    "saturation_score": num(h.get("saturation_score")),
                    "phys_score": num(h.get("phys_score")),
                    "nwp_score": num(h.get("nwp_score")),
                    "mechanism": h.get("mechanism"),
                    "mechanism_primary": h.get("mechanism_primary"),
                    "mechanisms": h.get("mechanisms") or {},
                    "model_mean": h.get("model_mean") or {},
                    "model_ids": h.get("model_ids") or snap.get("model_ids") or [],
                    "observation_assimilated_at_issue": bool(h.get("observation_assimilated")),
                    "issue_observation_visibility_m": num(h.get("observation_visibility_m")),
                    "issue_observation_phenomenon": h.get("observation_phenomenon"),
                },
                "probability": {t: probs[t] for t in TARGETS},
                "truth": {t: bool(truth[t]) for t in TARGETS},
                "outcome": outcomes,
            }
            cases.append(case)
    cases.sort(key=lambda c: (c["valid_time"], c["run_time"]))
    return cases


def metric_row(items: list[tuple[float, bool, str]]) -> dict:
    counts = {"HIT": 0, "FALSE_ALARM": 0, "MISS": 0, "CORRECT_NEGATIVE": 0}
    brier = []
    for prob, truth, label in items:
        counts[label] += 1
        brier.append((prob - (1.0 if truth else 0.0)) ** 2)
    h, fa, miss, cn = counts["HIT"], counts["FALSE_ALARM"], counts["MISS"], counts["CORRECT_NEGATIVE"]
    def ratio(a: float, b: float) -> float | None:
        return round(a / b, 4) if b else None
    return {
        "n": len(items),
        "hits": h,
        "false_alarms": fa,
        "misses": miss,
        "correct_negatives": cn,
        "pod": ratio(h, h + miss),
        "far": ratio(fa, h + fa),
        "csi": ratio(h, h + fa + miss),
        "accuracy": ratio(h + cn, len(items)),
        "brier": round(sum(brier) / len(brier), 5) if brier else None,
    }


def diagnostic_excerpt(case: dict, target: str) -> dict:
    f = case["forecast"]
    mm = f.get("model_mean") or {}
    t = num(mm.get("temperature_c"))
    td = num(mm.get("dew_point_c"))
    return {
        "target": target,
        "run_time": case["run_time"],
        "valid_time": case["valid_time"],
        "lead_hours": case["lead_hours"],
        "observed_state": case["observation"]["state"],
        "observed_visibility_m": case["observation"]["visibility_m"],
        "score": case["forecast"].get(f"{target.lower()}_score"),
        "predicted_visibility_m": f.get("predicted_visibility_m"),
        "mechanism": f.get("mechanism"),
        "saturation_score": f.get("saturation_score"),
        "mean_t_minus_td_c": round(t - td, 2) if t is not None and td is not None else None,
        "mean_wind_speed_ms": num(mm.get("wind_speed_ms")),
        "mean_relative_humidity_pct": num(mm.get("relative_humidity_pct")),
    }


def write_verification(cases: list[dict]) -> None:
    VERIFY_DIR.mkdir(parents=True, exist_ok=True)
    CASES_PATH.write_text("".join(json.dumps(c, ensure_ascii=False, separators=(",", ":")) + "\n" for c in cases), encoding="utf-8")

    grouped: dict[str, dict[str, list[tuple[float, bool, str]]]] = {
        t: defaultdict(list) for t in TARGETS
    }
    for c in cases:
        for target in TARGETS:
            label = c["outcome"].get(target)
            prob = c["probability"].get(target)
            if label is None or prob is None:
                continue
            truth = bool(c["truth"][target])
            grouped[target]["all"].append((prob, truth, label))
            grouped[target][c["lead_bucket"]].append((prob, truth, label))

    metrics = {}
    for target in TARGETS:
        metrics[target] = {bucket: metric_row(rows) for bucket, rows in sorted(grouped[target].items())}

    false_alarms = []
    misses = []
    for c in reversed(cases):
        for target in TARGETS:
            if c["outcome"].get(target) == "FALSE_ALARM" and len(false_alarms) < 30:
                false_alarms.append(diagnostic_excerpt(c, target))
            if c["outcome"].get(target) == "MISS" and len(misses) < 30:
                misses.append(diagnostic_excerpt(c, target))

    summary = {
        "schema": "prognozaepir-fog-legacy-verification-summary-v1",
        "generated_at": iso(mv.utcnow()),
        "engine": "LEGACY canonical browser runtime",
        "policy": {
            "forecast_must_precede_valid_time": True,
            "minimum_lead_minutes": MIN_LEAD_MIN,
            "observation_window_minutes": WINDOW_MIN,
            "threshold_score": 50,
            "fg_truth": "explicit FG/FZFG/BCFG/PRFG or non-precip visibility <1000 m; MIFG kept separate",
            "br_truth": "explicit BR or visibility 1000-5000 m when not FG/MIFG",
            "mifg_truth": "explicit MIFG only",
            "clear_negative": "visibility >5000 m with no FG/BR/MIFG",
        },
        "snapshots": len(load_snapshots()),
        "forecast_observation_cases": len(cases),
        "period": {
            "first_valid": cases[0]["valid_time"] if cases else None,
            "last_valid": cases[-1]["valid_time"] if cases else None,
        },
        "metrics": metrics,
        "recent_false_alarms": false_alarms,
        "recent_misses": misses,
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"LEGACY verification: cases={len(cases)} snapshots={summary['snapshots']}")
    for target in TARGETS:
        print(target, metrics.get(target, {}).get("all", {}))


def verify() -> None:
    write_verification(build_cases())


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="command", required=True)
    p_ingest = sub.add_parser("ingest-dom", help="validate headless DOM capture and append canonical snapshot")
    p_ingest.add_argument("dom", type=Path)
    sub.add_parser("verify", help="rebuild LEGACY forecast-to-METAR/SPECI verification")
    args = ap.parse_args()
    if args.command == "ingest-dom":
        append_snapshot(read_dom_payload(args.dom))
    elif args.command == "verify":
        verify()


if __name__ == "__main__":
    main()
