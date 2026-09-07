#!/usr/bin/env python3
from pathlib import Path


def patch_multisource(path: str) -> None:
    p = Path(path)
    s = p.read_text(encoding='utf-8')
    s = s.replace("TAF Sources v0.3.0", "TAF Sources v0.3.1")

    guard = r'''  function isMetarEpir(raw){
    const s=String(raw||'').replace(/\s+/g,' ').trim();
    if(!/\bEPIR\s+\d{6}Z\b/i.test(s)) return false;
    if(/\bTAF\b/i.test(s)||/\b\d{4}\/\d{4}\b/.test(s)) return false;
    if(/\b(?:BECMG|TEMPO|PROB30|PROB40|FM\d{6})\b/i.test(s)) return false;
    const wind=/\b(?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?KT\b/i.test(s);
    const vis=/\bCAVOK\b/i.test(s)||/\b(?:9999|\d{4})\b/.test(s);
    return wind&&vis;
  }

'''
    if 'function isMetarEpir(raw)' not in s:
        needle = '  function metars(text){\n'
        if needle not in s:
            raise SystemExit(f'{path}: metars() anchor not found')
        s = s.replace(needle, guard + needle, 1)

    old = "while((m=re.exec(one))){let raw=m[0].replace(/\\s+/g,' ').trim();if(raw&&!raw.endsWith('='))raw+='=';out.push(raw)}"
    new = "while((m=re.exec(one))){let raw=m[0].replace(/\\s+/g,' ').trim();if(raw&&!raw.endsWith('='))raw+='=';if(isMetarEpir(raw))out.push(raw)}"
    if old in s:
        s = s.replace(old, new, 1)
    elif new not in s:
        raise SystemExit(f'{path}: METAR candidate filter not found')

    old = "if(j?.metar_epir?.raw) metar.push({raw:j.metar_epir.raw,source:`Proxy · ${j.metar_epir.source||'multi-source'}`,t:Date.parse(j.metar_epir.obs_time||0)||0});"
    new = "if(j?.metar_epir?.raw&&isMetarEpir(j.metar_epir.raw)) metar.push({raw:j.metar_epir.raw,source:`Proxy · ${j.metar_epir.source||'multi-source'}`,t:Date.parse(j.metar_epir.obs_time||0)||0});"
    if old in s:
        s = s.replace(old, new, 1)
    elif new not in s:
        raise SystemExit(f'{path}: proxy METAR hook not found')

    old = "    if(bundle.metar?.raw) lines.push(bundle.metar.raw);"
    new = """    if(bundle.metar?.raw&&isMetarEpir(bundle.metar.raw)){
      const mr=String(bundle.metar.raw).trim();
      lines.push(/^(?:METAR|SPECI)\\b/i.test(mr)?mr:'METAR '+mr);
    }"""
    if old in s:
        s = s.replace(old, new, 1)
    elif new not in s:
        raise SystemExit(f'{path}: synthetic METAR hook not found')

    p.write_text(s, encoding='utf-8')


def patch_taf_html() -> None:
    p = Path('taf.html')
    s = p.read_text(encoding='utf-8')

    old = "new RegExp(`\\\\b(?:METAR|SPECI)?\\\\s*${station}\\\\s+\\\\d{6}Z\\\\b[\\\\s\\\\S]*?=`, 'gi')"
    new = "new RegExp(`\\\\b(?:METAR|SPECI)\\\\s+${station}\\\\s+\\\\d{6}Z\\\\b[\\\\s\\\\S]*?=`, 'gi')"
    if old in s:
        s = s.replace(old, new, 1)
    elif new not in s:
        raise SystemExit('taf.html: latestStationReport METAR regex not found')

    old = "function decodeMetarLive(raw){if(!raw)return null;raw="
    new = "function decodeMetarLive(raw){if(!raw)return null;if(/\\b\\d{4}\\/\\d{4}\\b/.test(raw)||/\\b(?:TAF|BECMG|TEMPO|PROB30|PROB40|FM\\d{6})\\b/i.test(raw))return null;raw="
    if old in s:
        s = s.replace(old, new, 1)
    elif new not in s:
        raise SystemExit('taf.html: decodeMetarLive guard anchor not found')

    p.write_text(s, encoding='utf-8')


def patch_proxy() -> None:
    p = Path('api/taf-proxy.js')
    s = p.read_text(encoding='utf-8')

    old = "const s = normalizeReport(raw).replace(/^TAF\\s+/i, '');"
    new = "const s = normalizeReport(raw);\n  if (/\\bTAF\\b/i.test(s) || /\\b\\d{4}\\/\\d{4}\\b/.test(s) || /\\b(?:BECMG|TEMPO|PROB30|PROB40|FM\\d{6})\\b/i.test(s)) return null;"
    if old in s:
        s = s.replace(old, new, 1)
    elif new not in s:
        raise SystemExit('proxy: metarMeta guard anchor not found')

    old = "    const raw = normalizeReport(m[0]);\n    const meta = metarMeta(raw);"
    new = "    const raw = normalizeReport(m[0]);\n    if (/\\bTAF\\b/i.test(raw) || /\\b\\d{4}\\/\\d{4}\\b/.test(raw) || /\\b(?:BECMG|TEMPO|PROB30|PROB40|FM\\d{6})\\b/i.test(raw)) continue;\n    const meta = metarMeta(raw);"
    if old in s:
        s = s.replace(old, new, 1)
    elif new not in s:
        raise SystemExit('proxy: extractMetarEpir guard anchor not found')

    p.write_text(s, encoding='utf-8')


patch_multisource('taf-multisource.js')
patch_multisource('taf.html')
patch_taf_html()
patch_proxy()

# Regression assertions for the exact failure seen in the UI.
t = Path('taf.html').read_text(encoding='utf-8')
p = Path('api/taf-proxy.js').read_text(encoding='utf-8')
assert 'TAF Sources v0.3.1' in t
assert 'function isMetarEpir(raw)' in t
assert "(?:METAR|SPECI)\\\\s+${station}" in t
assert "\\b\\d{4}\\/\\d{4}\\b" in t
assert "normalizeReport(raw);" in p
print('TAF/METAR guard applied successfully')
