#!/usr/bin/env python3
from pathlib import Path
import re
import sys

errors = []
client_path = Path('message-archive-client.js')
client = client_path.read_text(encoding='utf-8')
arch = Path('arch.html').read_text(encoding='utf-8')

# Canonical browser boundary: the shared client alone owns source priority.
# Live Railway is first, GitHub raw and Pages are fallbacks.
if "const RAILWAY_ROOT = 'https://central-ingestor-production.up.railway.app/data/messages';" not in client:
    errors.append('message-archive-client.js must define the live Railway archive root')
if "[CUSTOM_ROOT, RAILWAY_ROOT, GITHUB_ROOT, STATIC_ROOT]" not in client:
    errors.append('message-archive-client.js must keep Railway first, then GitHub/static fallbacks')
if 'fetchText:fetchArchiveText' not in client:
    errors.append('message-archive-client.js must expose the shared text/JSONL archive reader')
if 'window.PrognozaEPIRMessageArchive = api' not in client:
    errors.append('message-archive-client.js must expose the shared MessageArchive API')

# ARCH must consume the shared client and never own roots/source priority itself.
if not re.search(r'<script\b[^>]*src=["\']message-archive-client\.js(?:\?[^"\']*)?["\']', arch, re.I):
    errors.append('arch.html must load message-archive-client.js')
if 'PrognozaEPIRMessageArchive' not in arch or 'archive.fetchText(path,true)' not in arch:
    errors.append('arch.html must read daily archive files through the shared archive client')
if 'const GITHUB_ROOT=' in arch or 'const STATIC_ROOT=' in arch or 'const RAILWAY_ROOT=' in arch:
    errors.append('arch.html must not own archive roots or source priority')
if re.search(r'https?://[^\s"\']*railway[^\s"\']*/data/messages', arch, re.I):
    errors.append('arch.html must never read Railway data/messages directly')

# No browser/API consumer may hard-code Railway data/messages outside the shared client.
paths = list(Path('.').glob('*.html')) + list(Path('.').glob('*.js')) + list(Path('api').glob('*.js'))
for path in paths:
    if path == client_path:
        continue
    text = path.read_text(encoding='utf-8', errors='ignore')
    if re.search(r'https?://[^\s"\']*railway[^\s"\']*/data/messages', text, re.I):
        errors.append(f'{path}: bulletin consumer bypasses shared MessageArchive and points directly at Railway')

if errors:
    print('Archive consumer architecture check FAILED:')
    for item in errors:
        print(f' - {item}')
    sys.exit(1)
print('Archive consumer architecture check OK: Railway live first; GitHub/static fallback; shared client owns browser access.')
