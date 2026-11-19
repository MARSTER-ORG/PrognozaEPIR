#!/usr/bin/env python3
"""Guard Pages live verification against SIGPIPE under set -o pipefail."""
from pathlib import Path
import re
import subprocess

workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/pages-v2.yml").read_text(encoding="utf-8")
section = workflow.split("      - name: Verify live native Fog page and TAF startup", 1)[1].split(
    "      - name: Browser smoke test TAF cycles and hourly data", 1
)[0]

assert "set -euo pipefail" in section
assert "printf '%s'" not in section, "Do not pipe large assets to grep -q"
assert "| grep -Fq" not in section
assert len(re.findall(r'contains "\$[a-z]+" ', section)) >= 30

helper = re.search(r"          contains\(\) \{\n(.*?)\n          \}", section, re.S)
assert helper, "Missing bash contains() function"
function_text = "contains() {\n" + "\n".join(line.strip() for line in helper.group(1).splitlines()) + "\n}"
shell = """
set -euo pipefail
""" + function_text + """
data="$(python3 -c 'print("FOUND" + "x" * 1000000)')"
contains "$data" "FOUND"
! contains "$data" "MISSING"
contains "Legacy Fog Mode Sync" "Fog Mode"
"""
process = subprocess.run(["bash", "-c", shell], capture_output=True, text=True, check=False)
assert process.returncode == 0, (process.stdout, process.stderr)
print("Pages live verification pipefail regression: OK")
