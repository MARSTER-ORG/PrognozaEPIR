#!/usr/bin/env python3
from pathlib import Path
import re
import sys

errors = []
client = Path('message-archive-client.js').read_text(encoding='utf-8')
arch = Path('arch.html').read_text(encoding='utf-8')

if "return [GITHUB_ROOT, STATIC_ROOT];" not in client:
    errors.append('message-archive-client.js must keep GitHub raw first and Pages only as fallback')
if 'fetchText: fetchArchiveText' not in client:
    errors.append('message-archive-client.js must expose the shared text/JSONL archive reader')
if '<script src="message-archive-client.js"></script>' not in arch:
    errors.append('arch.html must load message-archive-client.js')
if 'PrognozaEPIRMessageArchive' not in arch or 'archive.fetchText(path,true)' not in arch:
    errors.append('arch.html must read daily archive files through the shared archive client')
if 'const GITHUB_ROOT=' in arch or 'const STATIC_ROOT=' in arch:
    errors.append('arch.html must not own archive roots or source priority')
if re.search(r'https?://[^\s"\']*railway[^\s"\']*/data/messages', arch, re.I):
    errors.append('arch.html must never read data/messages from Railway')

for path in list(Path('.').glob('*.html')) + list(Path('.').glob('*.js')) + list(Path('api').glob('*.js')):
    text = path.read_text(encoding='utf-8', errors='ignore')
    if re.search(r'https?://[^\s"\']*railway[^\s"\']*/data/messages', text, re.I):
        errors.append(f'{path}: browser/API bulletin consumer points directly at Railway data/messages')

if errors:
    print('Archive consumer architecture check FAILED:')
    for item in errors:
        print(f' - {item}')
    sys.exit(1)
print('Archive consumer architecture check OK: GitHub data/messages is authoritative; shared client owns browser access.')
