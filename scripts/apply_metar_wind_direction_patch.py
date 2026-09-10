#!/usr/bin/env python3
"""Apply the EPIR METAR-priority wind-direction verification upgrade.

Policy:
- regular EPIR METAR is the primary wind-direction observation (30 min cadence),
- SYNOP direction is fallback only,
- weak or rapidly changing direction is represented by a circular mean of
  three regular METARs centred on the verified whole hour when all three are
  available,
- the existing 1.5 m/s direction reliability boundary and 20 degree score
  tolerance are reused as the weak-wind / rapid-change boundaries.

The patch is deliberately idempotent and fails loudly if the expected source
layout has changed.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "scripts" / "model_verification.py"
text = PATH.read_text(encoding="utf-8")

VERSION_MARKER = 'WIND_DIRECTION_REFERENCE_VERSION = "metar-3-circular-v1"'
if VERSION_MARKER in text:
    print("METAR wind-direction patch already applied")
    raise SystemExit(0)


def replace_once(label: str, old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


replace_once(
    "wind reference constants",
    '''PARAM_WEIGHTS = {
    "temperature": 1.0,
    "dew_point": 1.0,
    "pressure": 0.8,
    "wind": 1.0,
    "visibility": 1.3,
    "cloud": 1.3,
    "precipitation": 0.6,
}
''',
    '''PARAM_WEIGHTS = {
    "temperature": 1.0,
    "dew_point": 1.0,
    "pressure": 0.8,
    "wind": 1.0,
    "visibility": 1.3,
    "cloud": 1.3,
    "precipitation": 0.6,
}

# EPIR wind-direction observation policy. Regular METAR is available every
# 30 minutes and is the primary reference for direction; SYNOP (hourly) is
# only a fallback. For weak or rapidly changing flow use a 3-METAR circular
# mean rather than an arithmetic mean, so 350/010/020 becomes about 007 deg.
WIND_DIRECTION_REFERENCE_VERSION = "metar-3-circular-v1"
WIND_DIRECTION_MIN_MS = 1.5
WIND_DIRECTION_RAPID_CHANGE_DEG = 20.0
WIND_REFERENCE_HALF_WINDOW_SECONDS = 31 * 60
'''
)

replace_once(
    "observation map",
    '''def build_observation_maps():
    metars = unique_rows(all_jsonl(METAR_DIR) + all_jsonl(SPECI_DIR), ("obs_time", "raw"))
    synops = unique_rows(all_jsonl(SYNOP_DIR), ("obs_time", "raw"))
    metar_by_hour = {}
    for m in metars:
        dt = parse_dt(m.get("obs_time"))
        if not dt:
            continue
        h = round_hour(dt)
        diff = abs((dt - h).total_seconds())
        if diff > 31 * 60:
            continue
        k = iso(h)
        prev = metar_by_hour.get(k)
        if prev is None or diff < prev[0]:
            metar_by_hour[k] = (diff, m)
    synop_by_hour = {}
    for s in synops:
        dt = parse_dt(s.get("obs_time"))
        if not dt:
            continue
        h = dt.replace(minute=0, second=0, microsecond=0)
        if abs((dt - h).total_seconds()) <= 10 * 60:
            synop_by_hour[iso(h)] = s
    return {k: v[1] for k, v in metar_by_hour.items()}, synop_by_hour
''',
    '''def build_observation_maps():
    # Keep regular METAR separate from SPECI for the direction reference.
    # SPECI may still be the closest observation for visibility/weather/cloud,
    # but it must not disturb the regular 30-minute 3-METAR direction window.
    regular_metars = unique_rows(all_jsonl(METAR_DIR), ("obs_time", "raw"))
    metars = unique_rows(regular_metars + all_jsonl(SPECI_DIR), ("obs_time", "raw"))
    synops = unique_rows(all_jsonl(SYNOP_DIR), ("obs_time", "raw"))

    regular_wind_points = []
    for m in regular_metars:
        dt = parse_dt(m.get("obs_time"))
        if dt:
            regular_wind_points.append((dt, m))
    regular_wind_points.sort(key=lambda x: x[0])

    metar_by_hour = {}
    for m in metars:
        dt = parse_dt(m.get("obs_time"))
        if not dt:
            continue
        h = round_hour(dt)
        diff = abs((dt - h).total_seconds())
        if diff > 31 * 60:
            continue
        k = iso(h)
        prev = metar_by_hour.get(k)
        if prev is None or diff < prev[0]:
            metar_by_hour[k] = (diff, m)

    # Enrich the closest METAR/SPECI row with an independently derived regular
    # METAR direction reference. component_scores() will consume this before
    # any direct METAR/SPECI direction and before SYNOP direction.
    metar_out = {}
    for k, (_diff, m) in metar_by_hour.items():
        row = dict(m)
        target = parse_dt(k)
        ref = metar_wind_reference(target, regular_wind_points) if target else None
        if ref:
            row.update(ref)
        metar_out[k] = row

    synop_by_hour = {}
    for s in synops:
        dt = parse_dt(s.get("obs_time"))
        if not dt:
            continue
        h = dt.replace(minute=0, second=0, microsecond=0)
        if abs((dt - h).total_seconds()) <= 10 * 60:
            synop_by_hour[iso(h)] = s
    return metar_out, synop_by_hour
'''
)

replace_once(
    "circular wind helpers",
    '''def circular_error(a, b):
    if not finite(a) or not finite(b):
        return None
    d = abs((a - b) % 360.0)
    return min(d, 360.0 - d)
''',
    '''def circular_error(a, b):
    if not finite(a) or not finite(b):
        return None
    d = abs((a - b) % 360.0)
    return min(d, 360.0 - d)


def circular_mean_deg(values):
    """Circular mean in degrees; never use arithmetic averaging for direction."""
    values = [float(v) % 360.0 for v in values if finite(v)]
    if not values:
        return None
    sx = sum(math.sin(math.radians(v)) for v in values)
    cy = sum(math.cos(math.radians(v)) for v in values)
    if math.hypot(sx, cy) < 1e-9:
        return None
    return (math.degrees(math.atan2(sx, cy)) + 360.0) % 360.0


def metar_wind_reference(target_dt, regular_wind_points):
    """Return METAR-priority direction for one whole-hour verification time.

    Regular METARs are nominally 30 minutes apart. Around a whole hour the
    centred window is therefore T-30, T, T+30. If the nearest wind is weak or
    adjacent directions change faster than the existing 20-degree full-score
    tolerance, use the circular mean of all three directions. If three usable
    regular METAR directions are unavailable, fall back to the nearest regular
    METAR and let component_scores() apply the weak-wind reliability guard.
    """
    if not target_dt:
        return None
    candidates = []
    for dt, row in regular_wind_points:
        diff = abs((dt - target_dt).total_seconds())
        if diff <= WIND_REFERENCE_HALF_WINDOW_SECONDS and finite(row.get("wind_direction_deg")):
            candidates.append((diff, dt, row))
    if not candidates:
        return None

    candidates.sort(key=lambda x: (x[0], x[1]))
    nearest = candidates[0][2]
    nearest_dir = nearest.get("wind_direction_deg")
    nearest_speed = nearest.get("wind_speed_ms")

    window = sorted(candidates[:3], key=lambda x: x[1])
    if len(window) == 3:
        directions = [x[2].get("wind_direction_deg") for x in window]
        changes = [circular_error(directions[i - 1], directions[i]) for i in range(1, 3)]
        rapid = any(finite(x) and x >= WIND_DIRECTION_RAPID_CHANGE_DEG for x in changes)
        weak = finite(nearest_speed) and nearest_speed < WIND_DIRECTION_MIN_MS
        if weak or rapid:
            mean_dir = circular_mean_deg(directions)
            if finite(mean_dir):
                speeds = [x[2].get("wind_speed_ms") for x in window]
                speeds = [float(x) for x in speeds if finite(x)]
                mean_speed = sum(speeds) / len(speeds) if speeds else nearest_speed
                return {
                    "wind_direction_reference_deg": mean_dir,
                    "wind_direction_reference_speed_ms": mean_speed,
                    "wind_direction_reference_source": "METAR_3_CIRCULAR_MEAN",
                    "wind_direction_reference_samples": [
                        {
                            "obs_time": iso(x[1]),
                            "direction_deg": x[2].get("wind_direction_deg"),
                            "speed_ms": x[2].get("wind_speed_ms"),
                        }
                        for x in window
                    ],
                }

    return {
        "wind_direction_reference_deg": nearest_dir,
        "wind_direction_reference_speed_ms": nearest_speed,
        "wind_direction_reference_source": "METAR_SINGLE",
        "wind_direction_reference_samples": [{
            "obs_time": nearest.get("obs_time"),
            "direction_deg": nearest_dir,
            "speed_ms": nearest_speed,
        }],
    }
'''
)

replace_once(
    "wind component scoring",
    '''    ws_obs = s.get("wind_speed_ms") if s and finite(s.get("wind_speed_ms")) else (m.get("wind_speed_ms") if m else None)
    wd_obs = s.get("wind_direction_deg") if s and finite(s.get("wind_direction_deg")) else (m.get("wind_direction_deg") if m else None)
    wind_parts = []
    if finite(f.get("wind_speed_ms")) and finite(ws_obs):
        wind_parts.append(tol_score(abs(f["wind_speed_ms"] - ws_obs), 1.5, 6.0))
    if finite(f.get("wind_direction_deg")) and finite(wd_obs) and (not finite(ws_obs) or ws_obs >= 1.5):
        wind_parts.append(tol_score(circular_error(f["wind_direction_deg"], wd_obs), 20.0, 90.0))
''',
    '''    # Wind speed verification keeps the existing SYNOP-first behaviour.
    # Direction is different by design: regular METAR reference first, then
    # direct METAR/SPECI, and SYNOP only as the final fallback.
    ws_obs = s.get("wind_speed_ms") if s and finite(s.get("wind_speed_ms")) else (m.get("wind_speed_ms") if m else None)
    wd_source = m.get("wind_direction_reference_source") if m else None
    if m and finite(m.get("wind_direction_reference_deg")):
        wd_obs = m.get("wind_direction_reference_deg")
    elif m and finite(m.get("wind_direction_deg")):
        wd_obs = m.get("wind_direction_deg")
        wd_source = "METAR_OR_SPECI_DIRECT"
    elif s and finite(s.get("wind_direction_deg")):
        wd_obs = s.get("wind_direction_deg")
        wd_source = "SYNOP_FALLBACK"
    else:
        wd_obs = None

    if m and finite(m.get("wind_direction_reference_speed_ms")):
        wd_speed_obs = m.get("wind_direction_reference_speed_ms")
    elif m and finite(m.get("wind_speed_ms")):
        wd_speed_obs = m.get("wind_speed_ms")
    elif s and finite(s.get("wind_speed_ms")):
        wd_speed_obs = s.get("wind_speed_ms")
    else:
        wd_speed_obs = None

    wind_parts = []
    if finite(f.get("wind_speed_ms")) and finite(ws_obs):
        wind_parts.append(tol_score(abs(f["wind_speed_ms"] - ws_obs), 1.5, 6.0))
    direction_reliable = (
        wd_source == "METAR_3_CIRCULAR_MEAN"
        or not finite(wd_speed_obs)
        or wd_speed_obs >= WIND_DIRECTION_MIN_MS
    )
    if finite(f.get("wind_direction_deg")) and finite(wd_obs) and direction_reliable:
        wind_parts.append(tol_score(
            circular_error(f["wind_direction_deg"], wd_obs),
            WIND_DIRECTION_RAPID_CHANGE_DEG,
            90.0,
        ))
'''
)

replace_once(
    "verification method description",
    '''        "method": "Archived forecast vs corresponding-hour EPIR METAR/SPECI and WMO 12342 SYNOP; weighted aviation-parameter tolerance score",
''',
    '''        "method": (
            "Archived forecast vs corresponding-hour EPIR METAR/SPECI and WMO 12342 SYNOP; "
            "wind direction uses regular METAR priority with a centred 3-METAR circular mean for weak/rapidly changing flow; "
            "weighted aviation-parameter tolerance score"
        ),
'''
)

PATH.write_text(text, encoding="utf-8")
print("Applied METAR-priority 3-METAR circular wind-direction reference patch")
