#!/usr/bin/env python3
import importlib.util
import re
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FINALIZER = ROOT / "scripts" / "finalize_central_message_architecture_v2.py"
RUNTIME_FILES = (
    "taf.html",
    "message-archive-client.js",
    "taf-fog-policy.js",
    "taf-engine-v2.js",
    "taf-engine-v24.js",
    "taf-engine-v241.js",
    "taf-engine-v242.js",
    "taf-engine-v243.js",
    "taf-app-v25.js",
)


def load_finalizer():
    spec = importlib.util.spec_from_file_location("taf_finalizer_runtime_test", FINALIZER)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def copy_runtime(destination: Path) -> None:
    for name in RUNTIME_FILES:
        shutil.copy2(ROOT / name, destination / name)


def expect_failure(validate, root: Path, expected: str) -> None:
    try:
        validate(root)
    except RuntimeError as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError(f"validator accepted invalid runtime; expected {expected!r}")


def main() -> int:
    finalizer = load_finalizer()
    assert finalizer.validate_taf_frontend(ROOT) == "v25-v243"

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        copy_runtime(root)
        html_path = root / "taf.html"
        html = html_path.read_text(encoding="utf-8")
        html = re.sub(
            r"\s*await loadScript\('taf-app-v25\.js[^\n]+",
            "\n      <!-- await loadScript('taf-app-v25.js?v=fake','taf-app-v25-runtime') -->",
            html,
            count=1,
        )
        html_path.write_text(html, encoding="utf-8")
        expect_failure(finalizer.validate_taf_frontend, root, "does not load taf-app-v25.js")

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        copy_runtime(root)
        html_path = root / "taf.html"
        html = html_path.read_text(encoding="utf-8").replace(
            "</body>", '<script src="taf-app-v2.js"></script>\n</body>',
        )
        html_path.write_text(html, encoding="utf-8")
        expect_failure(finalizer.validate_taf_frontend, root, "legacy taf-app-v2.js is active")

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        copy_runtime(root)
        app_path = root / "taf-app-v25.js"
        app_path.write_text(
            app_path.read_text(encoding="utf-8").replace(
                "const APP_ENGINE_VERSION='2.4.3'",
                "const APP_ENGINE_VERSION='2.4.2'",
            ),
            encoding="utf-8",
        )
        expect_failure(finalizer.validate_taf_frontend, root, "application contract incomplete")

    print("TAF finalizer active v25/v243 runtime tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
