#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("fog_legacy_archive", SCRIPTS / "fog_legacy_archive.py")
mod = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(mod)


def test_7000_is_clear_negative():
    truth = mod.obs_truth({
        "raw": "METAR EPIR 190200Z 18005KT 7000 NSC 09/08 Q1018",
        "visibility_m": 7000,
    })
    assert truth["state"] == "CLEAR", truth
    assert truth["FG"] is False
    assert truth["BR"] is False
    assert truth["MIFG"] is False


def test_targets_are_separate():
    fg = mod.obs_truth({"raw": "METAR EPIR 190200Z 03002KT 0600 FG VV002 08/08", "visibility_m": 600})
    br = mod.obs_truth({"raw": "METAR EPIR 190200Z 03002KT 3000 BR NSC 08/08", "visibility_m": 3000})
    mifg = mod.obs_truth({"raw": "METAR EPIR 190200Z 03002KT 9999 MIFG NSC 08/08", "visibility_m": 10000})
    assert fg["FG"] and not fg["BR"] and not fg["MIFG"]
    assert br["BR"] and not br["FG"] and not br["MIFG"]
    assert mifg["MIFG"] and not mifg["FG"] and not mifg["BR"]


def test_visibility_infers_br_but_not_at_7000():
    br = mod.obs_truth({"raw": "METAR EPIR 190200Z 03002KT 4000 NSC 08/08", "visibility_m": 4000})
    clear = mod.obs_truth({"raw": "METAR EPIR 190200Z 03002KT 7000 NSC 08/08", "visibility_m": 7000})
    assert br["BR"] is True
    assert clear["BR"] is False


def test_outcome_matrix():
    assert mod.outcome(.75, True) == "HIT"
    assert mod.outcome(.75, False) == "FALSE_ALARM"
    assert mod.outcome(.25, True) == "MISS"
    assert mod.outcome(.25, False) == "CORRECT_NEGATIVE"
    assert mod.outcome(None, False) is None


def test_dom_payload_parser():
    raw = '{"schema":"prognozaepir-fog-legacy-browser-snapshot-v1","captured_at":"2026-09-19T08:00:00Z","hours":[]}'
    text = '<html><body><pre id="fogLegacyArchivePayload" data-ready="1">' + raw.replace('&', '&amp;') + '</pre></body></html>'
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "capture.html"
        p.write_text(text, encoding="utf-8")
        payload = mod.read_dom_payload(p)
    assert payload["captured_at"] == "2026-09-19T08:00:00Z"


def run():
    test_7000_is_clear_negative()
    test_targets_are_separate()
    test_visibility_infers_br_but_not_at_7000()
    test_outcome_matrix()
    test_dom_payload_parser()
    print("fog LEGACY archive tests: OK")


if __name__ == "__main__":
    run()
