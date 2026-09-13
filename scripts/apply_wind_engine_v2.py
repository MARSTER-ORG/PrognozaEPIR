from pathlib import Path


def replace_once(text, old, new, label):
    if old in text:
        return text.replace(old, new, 1)
    if new in text:
        return text
    raise SystemExit(f"{label}: expected source pattern not found")


# 1) Main meteogram: -30 deg is an internal engine calibration.
p = Path("index.html")
s = p.read_text(encoding="utf-8")
s = replace_once(
    s,
    "const EPIR_WIND_DIR_CORR={from:190,to:235,offset:-25,minSpeedMs:1.5};",
    "const EPIR_WIND_DIR_CORR={from:190,to:235,offset:-30,minSpeedMs:1.5};",
    "index wind rule",
)
s = s.replace("neighbor-observation-context.js?v=neighbor-obs-v3", "neighbor-observation-context.js?v=neighbor-obs-v4")
s = s.replace("v0.9.15 HTML", "v0.9.16 HTML")
s = s.replace("HTML v0.9.15", "HTML v0.9.16")

wind_ui_old = "f(z.WD,0)+'° '+compass(z.WD)+(finite(z.windDirSectorCorrectionDeg)?' · surowy '+f(z.windDirRawDeg,0)+'° · korekta '+f(z.windDirSectorCorrectionDeg,0)+'°':'')"
wind_ui_new = "f(z.WD,0)+'° '+compass(z.WD)"
dir_ui_old = "f(z.WD,0)+'°'+(finite(z.windDirSectorCorrectionDeg)?' · surowy '+f(z.windDirRawDeg,0)+'° · korekta '+f(z.windDirSectorCorrectionDeg,0)+'°':'')"
dir_ui_new = "f(z.WD,0)+'°'"
s = replace_once(s, wind_ui_old, wind_ui_new, "wind UI")
s = replace_once(s, dir_ui_old, dir_ui_new, "direction UI")
p.write_text(s, encoding="utf-8")


# 2) Keep the observation-context module's internal rule consistent.
p = Path("neighbor-observation-context.js")
s = p.read_text(encoding="utf-8")
s = replace_once(
    s,
    "const SECTOR_WIND_DIR={from:190,to:235,offset:-25,minSpeedMs:1.5};",
    "const SECTOR_WIND_DIR={from:190,to:235,offset:-30,minSpeedMs:1.5};",
    "neighbor wind rule",
)
s = s.replace("version:'1.3.0'", "version:'1.4.0'", 1)
p.write_text(s, encoding="utf-8")


# 3) Accelerate adaptive learning only where sample depth supports it.
p = Path("scripts/build_adaptive_weights.py")
s = p.read_text(encoding="utf-8")
anchor = "VISIBILITY_EXACT_GOOD_WEIGHT = 1.0\n"
block = '''VISIBILITY_EXACT_GOOD_WEIGHT = 1.0

# Component-specific response speed. Wind has a deep verified EPIR sample and a
# persistent directional bias, so it may react faster to recent model skill.
# Cloud also has substantial history. Visibility stays conservative because
# genuinely reduced-visibility METAR cases are much rarer and right-censored.
COMPONENT_LEARNING = {
    "wind": {"half_life_days": 21.0, "full_samples": 60, "peer_scale_pct": 26.0},
    "cloud": {"half_life_days": 30.0, "full_samples": 75, "peer_scale_pct": 30.0},
    "visibility": {"half_life_days": 45.0, "full_samples": 100, "peer_scale_pct": 32.0},
}


def learning_cfg(comp=None):
    return COMPONENT_LEARNING.get(comp or "", {})
'''
if "COMPONENT_LEARNING = {" not in s:
    if anchor not in s:
        raise SystemExit("adaptive constants anchor not found")
    s = s.replace(anchor, block, 1)

old = '''def recency_weight(valid, now):
    age_days = max(0.0, (now - valid).total_seconds() / 86400.0)
    return 0.5 ** (age_days / HALF_LIFE_DAYS)


def confidence(n, effective_n):
    if n < MIN_SAMPLES or effective_n < MIN_SAMPLES * 0.55:
        return 0.0
    raw = (effective_n - MIN_SAMPLES * 0.55) / max(1.0, FULL_SAMPLES - MIN_SAMPLES * 0.55)
    # Smoothstep avoids a hard jump as soon as the minimum sample count is reached.
    x = clamp(raw, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def peer_factor(delta_pct):
    """Convert score advantage vs same-case peer median into a bounded factor."""
    if not mv.finite(delta_pct):
        return 1.0
    return clamp(math.exp(delta_pct / PEER_SCALE_PCT), MIN_FACTOR, MAX_FACTOR)
'''
new = '''def recency_weight(valid, now, comp=None):
    age_days = max(0.0, (now - valid).total_seconds() / 86400.0)
    half_life = float(learning_cfg(comp).get("half_life_days", HALF_LIFE_DAYS))
    return 0.5 ** (age_days / half_life)


def confidence(n, effective_n, comp=None):
    if n < MIN_SAMPLES or effective_n < MIN_SAMPLES * 0.55:
        return 0.0
    full_samples = float(learning_cfg(comp).get("full_samples", FULL_SAMPLES))
    raw = (effective_n - MIN_SAMPLES * 0.55) / max(1.0, full_samples - MIN_SAMPLES * 0.55)
    # Smoothstep avoids a hard jump as soon as the minimum sample count is reached.
    x = clamp(raw, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def peer_factor(delta_pct, comp=None):
    """Convert score advantage vs same-case peer median into a bounded factor."""
    if not mv.finite(delta_pct):
        return 1.0
    scale = float(learning_cfg(comp).get("peer_scale_pct", PEER_SCALE_PCT))
    return clamp(math.exp(delta_pct / scale), MIN_FACTOR, MAX_FACTOR)
'''
if old in s:
    s = s.replace(old, new, 1)
elif "def recency_weight(valid, now, comp=None):" not in s:
    raise SystemExit("adaptive learning functions not found")

s = s.replace("        rw = recency_weight(valid, now)\n        samples[(model, bucket)] += 1\n", "        samples[(model, bucket)] += 1\n", 1)
old_loop = '''        vis_weight = visibility_learning_weight(m, s)
        for comp, score in scores.items():
            comp_rw = rw * (vis_weight if comp == "visibility" else 1.0)
            abs_scores[(model, bucket, comp)].append((score, comp_rw))
'''
new_loop = '''        vis_weight = visibility_learning_weight(m, s)
        for comp, score in scores.items():
            comp_rw = recency_weight(valid, now, comp)
            if comp == "visibility":
                comp_rw *= vis_weight
            abs_scores[(model, bucket, comp)].append((score, comp_rw))
'''
if old_loop in s:
    s = s.replace(old_loop, new_loop, 1)
elif "comp_rw = recency_weight(valid, now, comp)" not in s:
    raise SystemExit("component recency block not found")

s = s.replace("conf = confidence(n, effective_n)", "conf = confidence(n, effective_n, comp)")
s = s.replace(
    "raw_factor = peer_factor(mean_delta) if mean_delta is not None else 1.0",
    "raw_factor = peer_factor(mean_delta, comp) if mean_delta is not None else 1.0",
)
s = s.replace(
    "sample-size shrinkage to base weights and conservative clipping; visibility learning emphasizes exact ",
    "component-specific recency/confidence response, sample-size shrinkage to base weights and conservative clipping; visibility learning emphasizes exact ",
)
marker = '        "factor_bounds": [MIN_FACTOR, MAX_FACTOR],\n'
if '"component_learning": COMPONENT_LEARNING' not in s:
    if marker not in s:
        raise SystemExit("adaptive output marker not found")
    s = s.replace(marker, marker + '        "component_learning": COMPONENT_LEARNING,\n', 1)
p.write_text(s, encoding="utf-8")

print("Wind engine migration applied: sector 190-235 deg, internal -30 deg.")
