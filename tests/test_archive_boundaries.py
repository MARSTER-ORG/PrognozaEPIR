from pathlib import Path
import importlib.util


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "check_archive_boundaries", ROOT / "scripts" / "check_archive_boundaries.py"
)
CHECKER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(CHECKER)


def test_bridge_only_mifg_is_not_a_direct_reader() -> None:
    path = ROOT / "mifg-engine.js"
    text = path.read_text(encoding="utf-8")
    assert CHECKER.direct_message_file_violations(path, text) == []
    assert "PrognozaEPIRFog244?.getMIFGSeries?.()" in text


def test_true_direct_reader_is_reported() -> None:
    path = ROOT / "synthetic-direct-reader.js"
    text = "fetch('data/messages/latest.json')"
    assert CHECKER.direct_message_file_violations(path, text) == [
        "synthetic-direct-reader.js: direct bulletin JSON/JSONL access bypasses shared MessageArchive client"
    ]


def main() -> int:
    test_bridge_only_mifg_is_not_a_direct_reader()
    test_true_direct_reader_is_reported()
    print("Archive boundary checker tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
