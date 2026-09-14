#!/usr/bin/env python3
from pathlib import Path
import re
import sys

errors = []
client_path = Path('message-archive-client.js')
client = client_path.read_text(encoding='utf-8')
arch = Path('arch.html').read_text(encoding='utf-8')

# Canonical browser boundary: the shared client alone owns source priority.
# Current architecture uses the central Supabase MessageArchive API as primary
# query/search boundary. Railway remains the first raw archive fallback, then
# GitHub raw and the Pages mirror. A custom root may explicitly override the
# raw fallback when configured by the application.
required_client_patterns = [
    (r"const\s+SUPABASE_API\s*=\s*['\"]https://[^'\"]+\.supabase\.co/functions/v1/message-archive['\"]", 'message-archive-client.js must define the central Supabase MessageArchive API'),
    (r"const\s+RAILWAY_ROOT\s*=\s*['\"]https://central-ingestor-production\.up\.railway\.app/data/messages['\"]", 'message-archive-client.js must keep the live Railway raw archive fallback'),
    (r"const\s+GITHUB_ROOT\s*=\s*['\"]https://raw\.githubusercontent\.com/MARSTER-ORG/PrognozaEPIR/main/data/messages['\"]", 'message-archive-client.js must keep the GitHub raw archive fallback'),
    (r"const\s+STATIC_ROOT\s*=\s*['\"]data/messages['\"]", 'message-archive-client.js must keep the Pages/static archive fallback'),
    (r"\[\s*CUSTOM_ROOT\s*,\s*RAILWAY_ROOT\s*,\s*GITHUB_ROOT\s*,\s*STATIC_ROOT\s*\]", 'message-archive-client.js must keep raw fallback order: custom, Railway, GitHub, static'),
    (r"async\s+function\s+fetchText\s*\(", 'message-archive-client.js must expose the shared text/JSONL archive reader implementation'),
    (r"\bfetchText\b", 'message-archive-client.js must publish the shared text/JSONL archive reader'),
    (r"\bsearch\b", 'message-archive-client.js must publish central archive search'),
    (r"window\.PrognozaEPIRMessageArchive\s*=\s*api", 'message-archive-client.js must expose the shared MessageArchive API'),
]
for pattern, message in required_client_patterns:
    if not re.search(pattern, client):
        errors.append(message)

# Primary API must be Supabase when enabled; raw roots are fallbacks rather than
# parallel browser-owned source selection.
if not re.search(r"const\s+PRIMARY_ROOT\s*=\s*SUPABASE_ENABLED\s*\?\s*SUPABASE_API\s*:\s*\(CUSTOM_ROOT\s*\|\|\s*RAILWAY_ROOT\)", client):
    errors.append('message-archive-client.js must keep central Supabase primary with Railway raw fallback')
if not re.search(r"async\s+function\s+fallback\s*\([^)]*\).*?for\s*\(const\s+root\s+of\s+fallbackRoots\(\)\)", client, re.S):
    errors.append('message-archive-client.js must resolve raw fallbacks only through the shared fallbackRoots order')

# ARCH must consume the shared API and never own roots/source priority itself.
if not re.search(r'<script\b[^>]*src=["\']message-archive-client\.js(?:\?[^"\']*)?["\']', arch, re.I):
    errors.append('arch.html must load message-archive-client.js')
if 'PrognozaEPIRMessageArchive' not in arch:
    errors.append('arch.html must use the shared MessageArchive API')
if not re.search(r'archive\.(?:search|getRange)\s*\(', arch):
    errors.append('arch.html must query archive rows through shared search/getRange methods')
if 'archive.search(' not in arch:
    errors.append('arch.html must use central MessageArchive search as its primary query path')
if 'const GITHUB_ROOT=' in arch or 'const STATIC_ROOT=' in arch or 'const RAILWAY_ROOT=' in arch or 'const SUPABASE_API=' in arch:
    errors.append('arch.html must not own archive roots or source priority')
if re.search(r'https?://[^\s"\']*(?:railway|supabase)[^\s"\']*/(?:data/messages|functions/v1/message-archive)', arch, re.I):
    errors.append('arch.html must never bypass the shared MessageArchive client with a direct archive endpoint')

# No browser/API consumer may hard-code the raw Railway archive or Supabase
# MessageArchive endpoint outside the shared client. The client is the single
# browser source-priority boundary.
paths = list(Path('.').glob('*.html')) + list(Path('.').glob('*.js')) + list(Path('api').glob('*.js'))
for path in paths:
    if path == client_path:
        continue
    text = path.read_text(encoding='utf-8', errors='ignore')
    if re.search(r'https?://[^\s"\']*railway[^\s"\']*/data/messages', text, re.I):
        errors.append(f'{path}: bulletin consumer bypasses shared MessageArchive and points directly at Railway')
    if re.search(r'https?://[^\s"\']*\.supabase\.co/functions/v1/message-archive', text, re.I):
        errors.append(f'{path}: bulletin consumer bypasses shared MessageArchive and points directly at Supabase')

if errors:
    print('Archive consumer architecture check FAILED:')
    for item in errors:
        print(f' - {item}')
    sys.exit(1)
print('Archive consumer architecture check OK: central Supabase API first; Railway/GitHub/static raw fallbacks; shared client owns browser access.')
