#!/usr/bin/env python3
"""Persist full verification diagnostics for PrognozaEPIR CONSENSUS.

The ordinary verification score remains unchanged. This module records signed
continuous errors (forecast minus observed), event contingency tables and
lead-time diagnostics from the same archived forecast population and central
EPIR observation archive used by model_verification.py.

Important observation rules:
- temperature/dew point/pressure: SYNOP first, METAR/SPECI fallback;
- wind speed: SYNOP first; wind direction: regular-METAR priority (delegated to
  consensus_wind_bias.py);
- visibility: METAR/SPECI first, SYNOP fallback; lower-bound reports such as
  METAR 9999 are treated as censored and never as an exact 10 km value;
- cloud cover: METAR layer ranges for LOW/MID/HIGH and SYNOP exact total oktas;
- precipitation: occurrence only (no amount bias without an observed hourly
  accumulation reference);
- fog and thunderstorm: occurrence diagnostics from WMO weather-code model
  votes versus METAR/SPECI/SYNOP present weather.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict

import consensus_wind_bias as cwb
import model_verification as mv

DIAGNOSTICS_SCHEMA = "prognozaepir-consensus-diagnostics-v1"
ERROR_DEFINITION = "forecast_minus_observed"
EVENT_VOTE_THRESHOLD = 0.5

FOG_CODES = {45, 48}
THUNDERSTORM_CODES = {95, 96, 99}


def _round(value, digits=3):
    return round(float(value), digits) if mv.finite(value) else None


def relative_humidity_from_temp_dewpoint(temp_c, dew_c):
    """Magnus approximation of RH (%) from observed temperature/dew point."""
    if not mv.finite(temp_c) or not mv.finite(dew_c):
        return None
    a = 17.625
    b = 243.04
    gamma_t = a * float(temp_c) / (b + float(temp_c))
    gamma_td = a * float(dew_c) / (b + float(dew_c))
    rh = 100.0 * math.exp(gamma_td - gamma_t)
    return max(0.0, min(100.0, rh))


def signed_range_error(value, allowed_range):
    """Signed distance to an observed categorical range; zero when inside."""
    if not mv.finite(value) or not allowed_range:
        return None
    lo, hi = allowed_range
    if value < lo:
        return float(value) - float(lo)
    if value > hi:
        return float(value) - float(hi)
    return 0.0


def _continuous_summary(errors, digits=3):
    values = [float(v) for v in errors if mv.finite(v)]
    if not values:
        return {"n": 0, "bias": None, "mae": None, "rmse": None}
    n = len(values)
    bias = sum(values) / n
    mae = sum(abs(v) for v in values) / n
    rmse = math.sqrt(sum(v * v for v in values) / n)
    return {
        "n": n,
        "bias": _round(bias, digits),
        "mae": _round(mae, digits),
        "rmse": _round(rmse, digits),
    }


def _event_summary(counts):
    hit = int(counts.get("hit", 0))
    miss = int(counts.get("miss", 0))
    false_alarm = int(counts.get("false_alarm", 0))
    correct_negative = int(counts.get("correct_negative", 0))
    n = hit + miss + false_alarm + correct_negative

    def pct(num, den):
        return round(100.0 * num / den, 1) if den else None

    return {
        "n": n,
        "hits": hit,
        "misses": miss,
        "false_alarms": false_alarm,
        "correct_negatives": correct_negative,
        "pod_pct": pct(hit, hit + miss),
        "far_pct": pct(false_alarm, hit + false_alarm),
        "csi_pct": pct(hit, hit + miss + false_alarm),
        "accuracy_pct": pct(hit + correct_negative, n),
        "observed_event_rate_pct": pct(hit + miss, n),
    }


def _add_event(counts, predicted, observed):
    if predicted is None or observed is None:
        return
    if predicted and observed:
        counts["hit"] += 1
    elif observed:
        counts["miss"] += 1
    elif predicted:
        counts["false_alarm"] += 1
    else:
        counts["correct_negative"] += 1


def _source_name(row, default):
    if not row:
        return None
    raw = str(row.get("raw") or "").lstrip().upper()
    typ = str(row.get("type") or "").upper()
    if default == "METAR_OR_SPECI":
        return "SPECI" if typ == "SPECI" or raw.startswith("SPECI") else "METAR"
    return default


def _scalar_reference(m, s, key, synop_first=True):
    candidates = ((s, "SYNOP"), (m, "METAR_OR_SPECI")) if synop_first else ((m, "METAR_OR_SPECI"), (s, "SYNOP"))
    for row, source in candidates:
        if row and mv.finite(row.get(key)):
            return float(row[key]), _source_name(row, source)
    return None, None


def _visibility_reference(m, s):
    for row, source in ((m, "METAR_OR_SPECI"), (s, "SYNOP")):
        if row and mv.finite(row.get("visibility_m")):
            return {
                "value_m": float(row["visibility_m"]),
                "lower_bound": bool(row.get("visibility_lower_bound")),
                "source": _source_name(row, source),
            }
    return None


def _metar_weather_tokens(m):
    if not m:
        return []
    text = " ".join([str(m.get("weather") or ""), str(m.get("raw") or "")]).upper()
    tokens = []
    for raw_token in text.replace("=", " ").split():
        token = raw_token.strip().lstrip("+-")
        if token and not token.startswith("VC"):
            tokens.append(token)
    return tokens


def precip_observation(m, s):
    """Return precipitation occurrence and the source that established it."""
    wet_codes = ("RA", "DZ", "SN", "SG", "PL", "GR", "GS", "UP")
    if m:
        wx = str(m.get("weather") or "").upper()
        raw = str(m.get("raw") or "").upper()
        if any(code in wx for code in wet_codes) or any(f" {code}" in raw for code in wet_codes):
            return True, _source_name(m, "METAR_OR_SPECI")
    if s and isinstance(s.get("present_weather_code"), int):
        ww = int(s["present_weather_code"])
        if 50 <= ww <= 99:
            return True, "SYNOP"
    if m:
        return False, _source_name(m, "METAR_OR_SPECI")
    if s:
        return False, "SYNOP"
    return None, None


def fog_observation(m, s):
    tokens = _metar_weather_tokens(m)
    fog_tokens = ("FG", "MIFG", "BCFG", "PRFG", "FZFG")
    if m:
        present = any(any(code in token for code in fog_tokens) for token in tokens)
        mifg = any("MIFG" in token for token in tokens)
        if present:
            return True, _source_name(m, "METAR_OR_SPECI"), mifg
    if s and isinstance(s.get("present_weather_code"), int):
        if 40 <= int(s["present_weather_code"]) <= 49:
            return True, "SYNOP", False
    if m:
        return False, _source_name(m, "METAR_OR_SPECI"), False
    if s:
        return False, "SYNOP", False
    return None, None, False


def thunderstorm_observation(m, s):
    tokens = _metar_weather_tokens(m)
    if m:
        present = any(token.startswith("TS") or "TS" in token for token in tokens)
        if present:
            return True, _source_name(m, "METAR_OR_SPECI")
    if s and isinstance(s.get("present_weather_code"), int):
        ww = int(s["present_weather_code"])
        if ww == 17 or 95 <= ww <= 99:
            return True, "SYNOP"
    if m:
        return False, _source_name(m, "METAR_OR_SPECI")
    if s:
        return False, "SYNOP"
    return None, None


def weighted_weather_event(rows, codes, threshold=EVENT_VOTE_THRESHOLD):
    yes = 0.0
    total = 0.0
    for row in rows:
        code = row.get("weather_code")
        weight = row.get("base_weight")
        if not mv.finite(code) or not mv.finite(weight) or weight <= 0:
            continue
        total += float(weight)
        if int(round(float(code))) in codes:
            yes += float(weight)
    if total <= 0:
        return None, None
    probability = yes / total
    return probability >= threshold, probability


def _new_accumulator():
    return {
        "sample_n": 0,
        "continuous": defaultdict(list),
        "sources": defaultdict(lambda: defaultdict(int)),
        "visibility_censored": {
            "n": 0,
            "underforecast_n": 0,
            "deficits_m": [],
        },
        "cloud_within": defaultdict(lambda: [0, 0]),
        "events": defaultdict(lambda: defaultdict(int)),
        "event_sources": defaultdict(lambda: defaultdict(int)),
        "fog_observed_mifg_n": 0,
    }


def _add_continuous(acc, name, pred, obs, source=None, error_override=None):
    if not mv.finite(pred) or not mv.finite(obs):
        return
    err = error_override if error_override is not None else float(pred) - float(obs)
    if not mv.finite(err):
        return
    acc["continuous"][name].append(float(err))
    if source:
        acc["sources"][name][source] += 1


def _consume(acc, forecast, model_rows, m, s):
    acc["sample_n"] += 1

    for name, key in (
        ("temperature", "temperature_c"),
        ("dew_point", "dew_point_c"),
        ("pressure", "pressure_hpa"),
    ):
        obs, source = _scalar_reference(m, s, key, synop_first=True)
        _add_continuous(acc, name, forecast.get(key), obs, source)

    t_obs, t_source = _scalar_reference(m, s, "temperature_c", synop_first=True)
    td_obs, td_source = _scalar_reference(m, s, "dew_point_c", synop_first=True)
    if mv.finite(t_obs) and mv.finite(td_obs):
        rh_obs = relative_humidity_from_temp_dewpoint(t_obs, td_obs)
        source = t_source if t_source == td_source else f"{t_source}+{td_source}"
        _add_continuous(acc, "relative_humidity", forecast.get("relative_humidity_pct"), rh_obs, source)

    gust_obs, gust_source = _scalar_reference(m, s, "wind_gust_ms", synop_first=False)
    _add_continuous(acc, "wind_gust", forecast.get("wind_gust_ms"), gust_obs, gust_source)

    vis = _visibility_reference(m, s)
    pred_vis = forecast.get("visibility_m")
    if vis and mv.finite(pred_vis):
        if vis["lower_bound"]:
            acc["visibility_censored"]["n"] += 1
            deficit = max(0.0, vis["value_m"] - float(pred_vis))
            if deficit > 0:
                acc["visibility_censored"]["underforecast_n"] += 1
                acc["visibility_censored"]["deficits_m"].append(deficit)
        else:
            _add_continuous(acc, "visibility_exact", pred_vis, vis["value_m"], vis["source"])
            if vis["value_m"] < 10000.0:
                _add_continuous(acc, "visibility_sub_10km", pred_vis, vis["value_m"], vis["source"])

    bands = mv.observed_cloud_bands(m)
    for band in ("low", "mid", "high"):
        pred_okta = mv.okta(forecast.get(f"{band}_pct"))
        observed_range = bands.get(band)
        if pred_okta is not None and observed_range is not None:
            err = signed_range_error(pred_okta, observed_range)
            name = f"cloud_{band}"
            _add_continuous(acc, name, pred_okta, 0.0, _source_name(m, "METAR_OR_SPECI"), error_override=err)
            acc["cloud_within"][name][1] += 1
            if err == 0:
                acc["cloud_within"][name][0] += 1

    if s and mv.finite(s.get("total_cloud_oktas")):
        total_pct = forecast.get("cloud_total_pct")
        if not mv.finite(total_pct):
            values = [forecast.get("low_pct"), forecast.get("mid_pct"), forecast.get("high_pct")]
            values = [v for v in values if mv.finite(v)]
            total_pct = max(values) if values else None
        pred_total = mv.okta(total_pct)
        _add_continuous(acc, "cloud_total", pred_total, s.get("total_cloud_oktas"), "SYNOP")

    wet_obs, wet_source = precip_observation(m, s)
    wet_pred = None
    if mv.finite(forecast.get("precipitation_mm")):
        wet_pred = float(forecast["precipitation_mm"]) >= 0.1
    _add_event(acc["events"]["precipitation"], wet_pred, wet_obs)
    if wet_pred is not None and wet_obs is not None and wet_source:
        acc["event_sources"]["precipitation"][wet_source] += 1

    fog_pred, _fog_prob = weighted_weather_event(model_rows, FOG_CODES)
    fog_obs, fog_source, mifg = fog_observation(m, s)
    _add_event(acc["events"]["fog"], fog_pred, fog_obs)
    if fog_pred is not None and fog_obs is not None and fog_source:
        acc["event_sources"]["fog"][fog_source] += 1
        if mifg:
            acc["fog_observed_mifg_n"] += 1

    ts_pred, _ts_prob = weighted_weather_event(model_rows, THUNDERSTORM_CODES)
    ts_obs, ts_source = thunderstorm_observation(m, s)
    _add_event(acc["events"]["thunderstorm"], ts_pred, ts_obs)
    if ts_pred is not None and ts_obs is not None and ts_source:
        acc["event_sources"]["thunderstorm"][ts_source] += 1


def _visibility_censored_summary(block):
    n = int(block["n"])
    under = int(block["underforecast_n"])
    deficits = [float(v) for v in block["deficits_m"] if mv.finite(v)]
    return {
        "n": n,
        "underforecast_n": under,
        "underforecast_rate_pct": round(100.0 * under / n, 1) if n else None,
        "mean_underforecast_deficit_m": _round(sum(deficits) / len(deficits), 1) if deficits else 0.0 if n else None,
        "max_underforecast_deficit_m": _round(max(deficits), 1) if deficits else 0.0 if n else None,
        "note": "Lower-bound observations are not treated as exact visibility values.",
    }


def _summarize(acc):
    units = {
        "temperature": "degC",
        "dew_point": "degC",
        "relative_humidity": "pct",
        "pressure": "hPa",
        "wind_gust": "m/s",
        "visibility_exact": "m",
        "visibility_sub_10km": "m",
        "cloud_low": "okta",
        "cloud_mid": "okta",
        "cloud_high": "okta",
        "cloud_total": "okta",
    }
    continuous = {}
    for name in units:
        item = _continuous_summary(acc["continuous"].get(name, []), 3)
        item["unit"] = units[name]
        item["sources"] = dict(sorted(acc["sources"].get(name, {}).items()))
        if name in acc["cloud_within"]:
            within, total = acc["cloud_within"][name]
            item["within_reported_range_pct"] = round(100.0 * within / total, 1) if total else None
        continuous[name] = item

    events = {}
    for name in ("precipitation", "fog", "thunderstorm"):
        item = _event_summary(acc["events"].get(name, {}))
        item["sources"] = dict(sorted(acc["event_sources"].get(name, {}).items()))
        if name == "fog":
            item["observed_mifg_n"] = int(acc["fog_observed_mifg_n"])
            item["mifg_note"] = "MIFG is inventoried separately; model WMO weather codes do not distinguish MIFG from other fog types."
        events[name] = item

    return {
        "eligible_samples": int(acc["sample_n"]),
        "continuous": continuous,
        "visibility_censored_lower_bound": _visibility_censored_summary(acc["visibility_censored"]),
        "events": events,
    }


def build_consensus_diagnostics(now=None):
    now = now or mv.utcnow()
    forecasts = mv.load_forecasts()
    metar_by_hour, synop_by_hour = mv.build_observation_maps()

    overall = _new_accumulator()
    by_bucket = {name: _new_accumulator() for _, _, name, _ in mv.LEAD_BUCKETS}

    grouped = defaultdict(list)
    for forecast in forecasts:
        grouped[(forecast.get("run_time"), forecast.get("valid_time"))].append(forecast)

    for rows in grouped.values():
        consensus = mv.consensus_row(rows)
        if not consensus:
            continue
        valid = mv.parse_dt(consensus.get("valid_time"))
        run = mv.parse_dt(consensus.get("run_time"))
        if not valid or not run or valid > now or run >= valid:
            continue
        key = mv.iso(valid.replace(minute=0, second=0, microsecond=0))
        m = metar_by_hour.get(key)
        s = synop_by_hour.get(key)
        if not m and not s:
            continue

        _consume(overall, consensus, rows, m, s)
        bucket = consensus.get("lead_bucket") or mv.lead_bucket((valid - run).total_seconds() / 3600.0)
        if bucket in by_bucket:
            _consume(by_bucket[bucket], consensus, rows, m, s)

    wind = cwb.build_consensus_wind_bias(now=now)
    overall_summary = _summarize(overall)
    by_bucket_summary = {name: _summarize(by_bucket[name]) for _, _, name, _ in mv.LEAD_BUCKETS}

    overall_summary["wind"] = wind["overall"]
    for _, _, name, _ in mv.LEAD_BUCKETS:
        by_bucket_summary[name]["wind"] = wind["by_lead_bucket"][name]

    return {
        "schema": DIAGNOSTICS_SCHEMA,
        "generated_at": mv.iso(now),
        "continuous_error_definition": ERROR_DEFINITION,
        "event_vote_threshold": EVENT_VOTE_THRESHOLD,
        "reference_policy": {
            "temperature_dewpoint_pressure": "SYNOP_FIRST_METAR_SPECI_FALLBACK",
            "relative_humidity": "DERIVED_FROM_OBSERVED_TEMPERATURE_AND_DEWPOINT",
            "visibility": "METAR_SPECI_FIRST_SYNOP_FALLBACK_CENSORED_LOWER_BOUNDS",
            "cloud_low_mid_high": "METAR_SPECI_LAYER_OKTA_RANGES",
            "cloud_total": "SYNOP_TOTAL_OKTAS",
            "precipitation": "METAR_SPECI_THEN_SYNOP_PRESENT_WEATHER",
            "fog": "METAR_SPECI_FG_FAMILY_THEN_SYNOP_WW40_49",
            "thunderstorm": "METAR_SPECI_TS_THEN_SYNOP_WW17_95_99",
            "wind_speed": wind["reference_policy"]["wind_speed"],
            "wind_direction": wind["reference_policy"]["wind_direction"],
        },
        "overall": overall_summary,
        "by_lead_bucket": by_bucket_summary,
        "limitations": {
            "cloud_base": "Not diagnosed: archived consensus forecast has no cloud-base field.",
            "precipitation_amount": "Not diagnosed: central verification observation set has occurrence but no guaranteed hourly accumulation reference.",
            "mifg_prediction": "Observed MIFG is counted, but WMO model weather codes do not provide a distinct MIFG forecast class.",
        },
        "wind_bias_schema": wind["schema"],
    }, wind


def enrich_summary():
    """Add full diagnostics and refresh legacy wind_bias in model-verification."""
    if not mv.SUMMARY_PATH.exists():
        raise FileNotFoundError(f"verification summary missing: {mv.SUMMARY_PATH}")

    diagnostics, wind = build_consensus_diagnostics()
    summary = json.loads(mv.SUMMARY_PATH.read_text(encoding="utf-8"))
    consensus = (summary.setdefault("models", {})).get("consensus")
    if not isinstance(consensus, dict):
        raise RuntimeError("model-verification.json has no consensus model block")

    consensus["wind_bias"] = wind
    consensus["diagnostics"] = diagnostics
    mv.SUMMARY_PATH.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return diagnostics


def main():
    diagnostics = enrich_summary()
    print(json.dumps({
        "schema": diagnostics["schema"],
        "generated_at": diagnostics["generated_at"],
        "eligible_samples": diagnostics["overall"]["eligible_samples"],
        "lead_buckets": list(diagnostics["by_lead_bucket"]),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
