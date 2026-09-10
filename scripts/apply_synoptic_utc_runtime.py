#!/usr/bin/env python3
"""Keep synoptic regime time classification in UTC in generated and live runtime."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGETS = (
    ROOT / "cloud-learning-client.js",
    ROOT / "index.html",
    ROOT / "scripts" / "apply_adaptive_runtime_patch.py",
    ROOT / "scripts" / "apply_synoptic_regime_upgrade.py",
)

REPLACEMENTS = (
    ("timeZone:'Europe/Warsaw'", "timeZone:'UTC'"),
    ('timeZone:"Europe/Warsaw"', 'timeZone:"UTC"'),
)


def main():
    changed = []
    for path in TARGETS:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        updated = text
        for old, new in REPLACEMENTS:
            updated = updated.replace(old, new)
        if updated != text:
            path.write_text(updated, encoding="utf-8")
            changed.append(str(path.relative_to(ROOT)))
    print("UTC synoptic runtime enforced:", ", ".join(changed) if changed else "already UTC")


if __name__ == "__main__":
    main()
