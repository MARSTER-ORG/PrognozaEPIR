#!/usr/bin/env python3
"""Enforce the project-wide UTC-only time policy in PrognozaEPIR.

Rules:
- application/runtime time is UTC, never Europe/Warsaw/local browser time;
- every user-facing clock value carries an explicit ``UTC`` suffix;
- every user-facing HTML page loads the shared ``utc-ui-guard.js`` runtime guard;
- raw aviation telegram syntax (for example DDHHMMZ) is left unchanged.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SELF = Path(__file__).resolve()
TEXT_SUFFIXES = {'.html', '.js', '.mjs', '.cjs', '.py', '.yml', '.yaml'}
SKIP_DIRS = {'.git', '.github', 'node_modules', 'data'}
UTC_GUARD_NAME = 'utc-ui-guard.js'

JS_DATE_REPLACEMENTS = (
    ('.getHours()', '.getUTCHours()'),
    ('.getMinutes()', '.getUTCMinutes()'),
    ('.getSeconds()', '.getUTCSeconds()'),
    ('.getDate()', '.getUTCDate()'),
    ('.getDay()', '.getUTCDay()'),
    ('.getMonth()', '.getUTCMonth()'),
    ('.getFullYear()', '.getUTCFullYear()'),
    ('.setHours(', '.setUTCHours('),
    ('.setMinutes(', '.setUTCMinutes('),
    ('.setSeconds(', '.setUTCSeconds('),
    ('.setDate(', '.setUTCDate('),
    ('.setMonth(', '.setUTCMonth('),
    ('.setFullYear(', '.setUTCFullYear('),
)


def source_files():
    for path in ROOT.rglob('*'):
        if path.resolve() == SELF:
            continue
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        rel = path.relative_to(ROOT)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        yield path


def html_files():
    return [p for p in source_files() if p.suffix.lower() == '.html']


def guard_src(rel: str) -> str:
    depth = len(Path(rel).parent.parts)
    return '../' * depth + UTC_GUARD_NAME


def ensure_utc_guard(text: str, rel: str) -> str:
    """Load the shared guard early on every HTML page, including future pages."""
    if not rel.lower().endswith('.html'):
        return text
    if re.search(r'<script\b[^>]*\bsrc=["\'][^"\']*utc-ui-guard\.js(?:[?#][^"\']*)?["\']', text, re.I):
        return text
    tag = f'<script src="{guard_src(rel)}"></script>'
    if re.search(r'</title\s*>', text, re.I):
        return re.sub(r'(</title\s*>)', r'\1\n' + tag, text, count=1, flags=re.I)
    if re.search(r'</head\s*>', text, re.I):
        return re.sub(r'(</head\s*>)', tag + r'\n\1', text, count=1, flags=re.I)
    return tag + '\n' + text


def patch_index(text: str) -> str:
    text = text.replace("const PLACE={lat:52.7989,lon:18.2639,tz:'Europe/Warsaw'};", "const PLACE={lat:52.7989,lon:18.2639,tz:'UTC'};")
    old = "const _fmtCache=new Map();function fmt(ms,opt){const k=JSON.stringify(opt);let x=_fmtCache.get(k);if(!x){x=new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,...opt});_fmtCache.set(k,x)}return x.format(new Date(ms))}"
    new = "const _fmtCache=new Map();function fmt(ms,opt={}){const k=JSON.stringify(opt);let x=_fmtCache.get(k);if(!x){x=new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',...opt});_fmtCache.set(k,x)}const value=x.format(new Date(ms));return ('hour'in opt||'minute'in opt||'second'in opt)?value+' UTC':value}"
    text = text.replace(old, new)
    text = text.replace("$('updated').textContent=new Date().toLocaleString('pl-PL');", "$('updated').textContent='Aktualizacja: '+fmt(Date.now(),{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});")
    return text


def patch_arch(text: str) -> str:
    text = text.replace(
        "function formatUtc(ms){return Number.isFinite(ms)?new Date(ms).toISOString().slice(0,16).replace('T',' '):'—'}",
        "function formatUtc(ms){return Number.isFinite(ms)?new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC':'—'}",
    )
    return text


def patch_taf(text: str) -> str:
    text = text.replace(
        "<tr><td>${pad(new Date(z.t).getUTCHours())}:00</td>",
        "<tr><td>${pad(new Date(z.t).getUTCHours())}:00 UTC</td>",
    )
    text = text.replace(
        "$('st').textContent=new Date().toLocaleTimeString('pl-PL')",
        "$('st').textContent=fu(Date.now()).slice(6)",
    )
    text = text.replace('<tr><th>UTC</th><th>Wiatr</th>', '<tr><th>Czas UTC</th><th>Wiatr</th>')
    return text


def patch_radar(text: str) -> str:
    old = "function fmtTime(ms){return new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}).format(new Date(ms))}"
    new = "function fmtTime(ms){return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}).format(new Date(ms))+' UTC'}"
    text = text.replace(old, new)

    old2 = "function fmtLocal(sec){try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',hour:'2-digit',minute:'2-digit'}).format(new Date(sec*1000));}catch(_){return new Date(sec*1000).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});}}"
    new2 = "function fmtUtc(sec){try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'}).format(new Date(sec*1000))+' UTC';}catch(_){return new Date(sec*1000).toISOString().slice(11,16)+' UTC';}}"
    text = text.replace(old2, new2).replace('fmtLocal(', 'fmtUtc(')

    text = text.replace(
        "setStatus(`aktualizacja ${new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'})} · klatka ${fmtUtc(latest.time)}`);",
        "setStatus(`aktualizacja ${new Date().toISOString().slice(11,16)} UTC · klatka ${fmtUtc(latest.time)}`);",
    )
    text = text.replace(
        "$('updated').textContent='Aktualizacja: '+new Date().toLocaleString('pl-PL');",
        "$('updated').textContent='Aktualizacja: '+fmtTime(Date.now());",
    )

    marker = "function f(v,d=0){return finite(v)?Number(v).toFixed(d):'—'}"
    if marker in text and 'function fmtExternalUtc(' not in text:
        text = text.replace(marker, marker + "\nfunction fmtExternalUtc(value){if(!value)return '';const ms=Date.parse(value);return Number.isFinite(ms)?fmtTime(ms):String(value)}")
    text = text.replace("'<br><small>'+od+' → '+do_+'</small>'", "'<br><small>'+fmtExternalUtc(od)+' → '+fmtExternalUtc(do_)+'</small>'")
    text = text.replace('<th>Czas</th><th>Temp.</th>', '<th>Czas UTC</th><th>Temp.</th>')
    return text


PAGE_PATCHERS = {
    'index.html': patch_index,
    'arch.html': patch_arch,
    'taf.html': patch_taf,
    'radar.html': patch_radar,
}


def normalize_utc(text: str, suffix: str) -> str:
    text = text.replace("'Europe/Warsaw'", "'UTC'").replace('"Europe/Warsaw"', '"UTC"')
    if suffix in {'.html', '.js', '.mjs', '.cjs'}:
        for old, new in JS_DATE_REPLACEMENTS:
            text = text.replace(old, new)
    return text


def apply() -> list[str]:
    changed = []
    for path in source_files():
        rel = path.relative_to(ROOT).as_posix()
        text = path.read_text(encoding='utf-8')
        updated = text
        patcher = PAGE_PATCHERS.get(rel)
        if patcher:
            updated = patcher(updated)
        updated = normalize_utc(updated, path.suffix.lower())
        if path.suffix.lower() == '.html':
            updated = ensure_utc_guard(updated, rel)
        if updated != text:
            path.write_text(updated, encoding='utf-8')
            changed.append(rel)
    return changed


def validate_guard(errors: list[str]) -> None:
    guard = ROOT / UTC_GUARD_NAME
    if not guard.exists():
        errors.append(f'{UTC_GUARD_NAME}: missing global UTC UI guard')
        return
    text = guard.read_text(encoding='utf-8')
    required = [
        "timeZone: 'UTC'",
        "MutationObserver",
        "CanvasRenderingContext2D",
        "markUtc",
        "data-tooltip",
        "toLocaleTimeString",
        "Intl.DateTimeFormat",
    ]
    for token in required:
        if token not in text:
            errors.append(f'{UTC_GUARD_NAME}: missing runtime invariant {token}')


def validate() -> list[str]:
    errors = []
    forbidden = [
        "Europe/Warsaw",
        '.getHours()', '.getMinutes()', '.getSeconds()', '.getDate()', '.getDay()', '.getMonth()', '.getFullYear()',
        '.setHours(', '.setMinutes(', '.setSeconds(', '.setDate(', '.setMonth(', '.setFullYear(',
    ]
    for path in source_files():
        text = path.read_text(encoding='utf-8')
        rel = path.relative_to(ROOT).as_posix()
        for token in forbidden:
            if token in text:
                errors.append(f'{rel}: forbidden local-time token {token}')

    validate_guard(errors)

    # Every current and future user-facing HTML page must load the guard.
    for path in html_files():
        rel = path.relative_to(ROOT).as_posix()
        text = path.read_text(encoding='utf-8')
        expected = guard_src(rel)
        if not re.search(r'<script\b[^>]*\bsrc=["\']' + re.escape(expected) + r'(?:[?#][^"\']*)?["\']', text, re.I):
            errors.append(f'{rel}: missing global UTC UI guard ({expected})')

    required = {
        'index.html': ["tz:'UTC'", "?value+' UTC':value", "Aktualizacja: '+fmt(Date.now()"],
        'arch.html': ["replace('T',' ')+' UTC'"],
        'taf.html': [":00 UTC</td>", "$('st').textContent=fu(Date.now()).slice(6)"],
        'radar.html': ["function fmtTime(ms)", "timeZone:'UTC'", ".format(new Date(ms))+' UTC'", 'function fmtUtc(sec)', 'fmtExternalUtc(od)', '<th>Czas UTC</th>'],
        'sat-fog.html': ["timeZone:'UTC'", "+' UTC'"],
    }
    for rel, tokens in required.items():
        path = ROOT / rel
        if not path.exists():
            errors.append(f'{rel}: missing user-facing page')
            continue
        text = path.read_text(encoding='utf-8')
        for token in tokens:
            if token not in text:
                errors.append(f'{rel}: missing UTC UI invariant {token}')
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()

    if not args.check:
        changed = apply()
        print('UTC policy updated:', ', '.join(changed) if changed else 'already compliant')

    errors = validate()
    if errors:
        print('UTC policy violations:')
        for error in errors:
            print(' -', error)
        return 1
    print('UTC policy check: OK')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
