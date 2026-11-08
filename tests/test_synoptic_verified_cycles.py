#!/usr/bin/env python3
"""No-lookahead guard: a collection timestamp is not an NWP model cycle."""
from datetime import datetime, timezone
from pathlib import Path
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import enrich_synoptic_context as enrich

now = datetime(2026, 11, 8, 16, tzinfo=timezone.utc)
valid = "2026-11-08T09:00:00Z"
true_cycle = "2026-11-08T06:00:00Z"

def row(**kw):
    base = dict(
        schema="prognozaepir-fog-vnext-forecast-v1",
        archive_source="open-meteo-single-runs",
        model="ecmwf_ifs",
        run_time="2026-11-08T08:36:12Z",  # archive batch, NOT model init
        model_run_time=true_cycle,
        valid_time=valid,
    )
    base.update(kw)
    return base

p = Path("synthetic.jsonl")
rows = [
    row(),
    row(model="icon_d2"),
    row(model="dmi_harmonie_arome_europe"),
    row(model="knmi_harmonie_arome_europe"),
    row(model_run_time=None),
    row(archive_source="open-meteo-previous-runs"),
    row(archive_source=None, model_run_time=None, run_time="2026-11-08T08:37:00Z"),
    row(model_run_time="2026-11-08T09:00:00Z"),
    row(model_run_time="2026-11-09T06:00:00Z"),
]
pending = enrich.candidate_runs({p: rows}, now)
assert len(pending) == 4, pending
assert {model for _, model, _ in pending} == {
    "ecmwf_ifs", "icon_d2", "dmi_harmonie_arome_europe",
    "knmi_harmonie_arome_europe"
}
for actual_cycle, model, refs in pending:
    assert enrich.mv.iso(actual_cycle) == true_cycle, (model, actual_cycle)
    assert all(ref["model_run_time"] == true_cycle for _, _, ref in refs)
    assert all(ref["archive_source"] == "open-meteo-single-runs" for _, _, ref in refs)

seen = []
original = enrich.get_json
try:
    def fake_get_json(url, **kwargs):
        seen.append(urllib.parse.parse_qs(urllib.parse.urlparse(url).query))
        return {"hourly": {"time": ["2026-11-08T07:00"], "temperature_925hPa":[-2.0],
                          "relative_humidity_850hPa":[92]}}
    enrich.get_json = fake_get_json
    payload = enrich.request("ecmwf_ifs", enrich.mv.parse_dt(true_cycle),
                             ["temperature_925hPa", "relative_humidity_850hPa"])
finally:
    enrich.get_json = original
assert seen and seen[0]["run"] == ["2026-11-08T06:00"], seen
assert seen[0]["models"] == ["ecmwf_ifs"]
ctx = enrich.context_from_payload(payload)
assert ctx["2026-11-08T07:00:00Z"]["temperature_925hpa_c"] == -2.0
assert ctx["2026-11-08T07:00:00Z"]["relative_humidity_850hpa_pct"] == 92
assert not enrich.context_from_payload({
    "hourly":{"time":["2026-11-08T07:00"], "temperature_925hPa":[None]}
}), "all-null pressure data must never be counted as enriched"
print("synoptic verified-cycle and finite-pressure tests: OK")
