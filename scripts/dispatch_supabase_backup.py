#!/usr/bin/env python3
"""Dispatch the Supabase backup workflow through the existing Railway GitHub token."""
from __future__ import annotations

import json
import os
import sys
from urllib.request import Request, urlopen

TOKEN=os.environ.get('GITHUB_ARCHIVE_DISPATCH_TOKEN','').strip()
URL=os.environ.get('GITHUB_ARCHIVE_DISPATCH_URL','https://api.github.com/repos/MARSTER-ORG/PrognozaEPIR/dispatches').strip()

if not TOKEN:
    print('backup dispatch skipped: missing GITHUB_ARCHIVE_DISPATCH_TOKEN', file=sys.stderr)
    raise SystemExit(2)

body=json.dumps({'event_type':'supabase-backup-now','client_payload':{'source':'railway-verification'}}).encode('utf-8')
req=Request(URL,data=body,method='POST',headers={
    'Accept':'application/vnd.github+json',
    'Authorization':f'Bearer {TOKEN}',
    'Content-Type':'application/json',
    'User-Agent':'PrognozaEPIR-Supabase-Backup-Dispatch/1',
    'X-GitHub-Api-Version':'2022-11-28',
})
with urlopen(req,timeout=12) as response:
    status=int(getattr(response,'status',0) or 0)
if status not in {200,201,202,204}:
    raise SystemExit(f'backup dispatch failed: HTTP {status}')
print(json.dumps({'ok':True,'event_type':'supabase-backup-now','status':status},sort_keys=True))
