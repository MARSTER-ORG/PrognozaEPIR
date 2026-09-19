#!/usr/bin/env python3
"""Wire the deployed FOG/BR/MIFG runtimes.

``fog.html`` is the canonical Fog runtime.  The meteogram must not execute its
own copy of Fog/BR/MIFG engines because its global model state differs from the
standalone Fog page.  ``index.html`` therefore consumes the canonical same-
origin ``fog.html`` runtime through ``fog-index-bridge.js`` and only draws the
published series.
"""
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "_site"
ASSET_V = os.environ.get("GITHUB_SHA", "dev")[:12]
FOG_PAGE_ASSETS = (
    "fog-mode-switch.js",
    "fog-engine.js",
    "mifg-engine.js",
    "fog-summary-layout.js",
    "br-engine.js",
    "fog-page-layout.js",
    "fog-visibility-cells.js",
)
INDEX_FOG_RUNTIME_ASSETS = (
    "fog-engine.js",
    "observation-engine.js",
    "mifg-engine.js",
    "br-engine.js",
    "fog-summary-layout.js",
    "fog-mode-switch.js",
    "fog-index-bridge.js",
    "fog-meteogram-overlay.js",
)


def patch_fog() -> None:
    p = SITE / "fog-engine.js"
    s = p.read_text(encoding="utf-8")
    old_hour = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});}
  }"""
    new_hour = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'}).format(new Date(t))+' UTC';}
    catch(_){return String(new Date(t).getUTCHours()).padStart(2,'0')+':'+String(new Date(t).getUTCMinutes()).padStart(2,'0')+' UTC';}
  }"""
    old_dt = """  function localDateTime(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleString('pl-PL');}
  }"""
    new_dt = """  function localDateTime(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t))+' UTC';}
    catch(_){return new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC';}
  }"""
    if old_hour not in s or old_dt not in s:
        raise SystemExit("FOG UTC formatter markers not found")
    s = s.replace(old_hour, new_hour, 1).replace(old_dt, new_dt, 1)
    s = s.replace("timeZone:PLACE.tz,year:'numeric'", "timeZone:'UTC',year:'numeric'", 1)

    old_parse = "function parseLocalInput(v){return v?Date.parse(v):NaN;}"
    new_parse = "function parseLocalInput(v){return v?Date.parse(/[zZ]|[+-]\\d\\d:\\d\\d$/.test(v)?v:v+'Z'):NaN;}"
    if old_parse not in s:
        raise SystemExit("FOG datetime-local parser marker not found")
    s = s.replace(old_parse, new_parse, 1)

    active_export = "fogSeries=out;window.PrognozaEPIRFogSeries=fogSeries;"
    legacy_export = (
        "fogSeries=out;"
        "window.PrognozaEPIRFogLegacySeries=fogSeries.map(h=>({...h,models:Array.isArray(h?.models)?h.models.map(m=>({...m,components:m?.components?{...m.components}:m?.components})):h?.models,fogEngineMode:'legacy',fogEngineSource:'legacy'}));"
        "window.PrognozaEPIRFogSeries=fogSeries;"
    )
    if "PrognozaEPIRFogLegacySeries" not in s:
        if active_export not in s:
            raise SystemExit("FOG active series export marker not found")
        s = s.replace(active_export, legacy_export, 1)
    p.write_text(s, encoding="utf-8")


def patch_fg_semantics() -> None:
    """Do not label BR-range visibility as operational FG in the LEGACY UI."""
    p = SITE / "fog-engine.js"
    s = p.read_text(encoding="utf-8")

    old_event = """  function onsetAndDissipation(series){
    const idx=series.findIndex(x=>finite(x?.score)&&x.score>=50);
    const onset=idx>=0?series[idx].t:null;
    let end=null;
    if(idx>=0){
      let last=idx;
      while(last+1<series.length&&finite(series[last+1]?.score)&&series[last+1].score>=50)last++;
      end=series[last+1]?.t??null;
    }
    const peak=series.reduce((a,b)=>!a||b.score>a.score?b:a,null);
    let peakFrom=null,peakTo=null;
    if(peak&&peak.score>=50){
      const thr=Math.max(50,.85*peak.score),pi=series.indexOf(peak);let a=pi,b=pi;
      while(a>0&&series[a-1].score>=thr)a--;
      while(b<series.length-1&&series[b+1].score>=thr)b++;
      peakFrom=series[a].t;peakTo=series[b].t;
    }
    return {onset,end,peak,peakFrom,peakTo};
  }"""
    new_event = """  function isOperationalFg(x){
    if(!finite(x?.score)||x.score<50)return false;
    if(finite(x?.vis))return x.vis<1000;
    return finite(x?.vis1000)&&x.vis1000>=50;
  }
  function onsetAndDissipation(series){
    const idx=series.findIndex(isOperationalFg);
    const onset=idx>=0?series[idx].t:null;
    let end=null;
    if(idx>=0){
      let last=idx;
      while(last+1<series.length&&isOperationalFg(series[last+1]))last++;
      end=series[last+1]?.t??null;
    }
    const fgRows=series.filter(isOperationalFg);
    const peak=fgRows.reduce((a,b)=>!a||b.score>a.score?b:a,null);
    let peakFrom=null,peakTo=null;
    if(peak){
      const thr=Math.max(50,.85*peak.score),pi=series.indexOf(peak);let a=pi,b=pi;
      while(a>0&&isOperationalFg(series[a-1])&&series[a-1].score>=thr)a--;
      while(b<series.length-1&&isOperationalFg(series[b+1])&&series[b+1].score>=thr)b++;
      peakFrom=series[a].t;peakTo=series[b].t;
    }
    return {onset,end,peak,peakFrom,peakTo};
  }"""
    if old_event not in s:
        raise SystemExit("FOG operational event marker not found")
    s = s.replace(old_event, new_event, 1)

    old_threshold = """      <div class=\"fog-thresholds\"><b>Interpretacja operacyjna:</b> &lt;50 = MGŁA: NIE (wynik pomijany) · 50–59 = MOŻLIWA · 60–79 = PRAWDOPODOBNA · 80–100 = BARDZO PRAWDOPODOBNA. <b>Kolor i komunikat wynikają wyłącznie z końcowego EPIR score.</b> Wynik /100 jest score ryzyka, nie skalibrowanym procentem P(FG).</div>"""
    new_threshold = """      <div class=\"fog-thresholds\"><b>Interpretacja operacyjna FG:</b> score EPIR opisuje potencjał procesu, ale <b>FG wymaga także prognozowanej VIS &lt;1000 m</b>. VIS 1000–5000 m należy do BR. Wynik /100 nie jest skalibrowanym procentem P(FG).</div>"""
    if old_threshold not in s:
        raise SystemExit("FOG threshold explanation marker not found")
    s = s.replace(old_threshold, new_threshold, 1)

    old_summary = """    const type=peak.type?.text||current.type?.text||'—';
    const freeze=peak.fzfg;
    summary.innerHTML=`
      <div class=\"fog-card ${riskCss(current.score)}\"><small>MGŁA W CIĄGU NAJBLIŻSZEJ GODZINY</small><strong>${scoreClass(current.score)}</strong><em>${current.score>=50?fmt0(current.score)+'/100':'wynik <50/100 pominięty'}</em></div>
      <div class=\"fog-card\"><small>Typ procesu</small><strong>${type}</strong><em>${peak.type?.secondary?'wtórny: '+mechanismName(peak.type.secondary):'dominujący mechanizm'}</em></div>
      <div class=\"fog-card\"><small>Kiedy mgła?</small><strong>${ev.onset?localDateTime(ev.onset)+' UTC → '+(ev.end?localDateTime(ev.end)+' UTC':'dalej'):'brak sygnału ≥50 w 48 h'}</strong><em>próg operacyjny 50/100</em></div>
      <div class=\"fog-card ${riskCss(peak.score)}\"><small>Maksimum w 48 h</small><strong>${peak.score>=50?scoreClass(peak.score):'PONIŻEJ PROGU'}</strong><em>${peak.score>=50?fmt0(peak.score)+'/100 · '+(ev.peakFrom?localDateTime(ev.peakFrom)+' UTC – '+localDateTime(ev.peakTo)+' UTC':localDateTime(peak.t)+' UTC'):'brak operacyjnej mgły'}</em></div>
      <div class=\"fog-card\"><small>VIS &lt;1000 / &lt;500 m</small><strong>${fmt0(current.vis1000)}/100 · ${fmt0(current.vis500)}/100</strong><em>VIS EPIR ${fmtM(current.vis)}</em></div>
      <div class=\"fog-card\"><small>VIS &lt;1500 / &lt;200 m</small><strong>${fmt0(current.vis1500)}/100 · ${fmt0(current.vis200)}/100</strong><em>osobne zagrożenia</em></div>
      <div class=\"fog-card\"><small>Mgła marznąca</small><strong>${freeze}</strong><em>T przy maksimum ${fmt1(peak.T)}°C</em></div>
      <div class=\"fog-card\"><small>Pewność prognozy</small><strong>${confidenceLabel(current.confidence)}</strong><em>${fmt0((current.confidence??0)*100)}% wskaźnika CONF</em></div>`;"""
    new_summary = """    const type=peak.type?.text||current.type?.text||'—';
    const currentFg=isOperationalFg(current),peakFg=isOperationalFg(peak);
    const freeze=peakFg?peak.fzfg:'NIE';
    summary.innerHTML=`
      <div class=\"fog-card ${riskCss(currentFg?current.score:null)}\"><small>MGŁA W CIĄGU NAJBLIŻSZEJ GODZINY</small><strong>${currentFg?scoreClass(current.score):'NIE'}</strong><em>${currentFg?fmt0(current.score)+'/100 · VIS '+fmtM(current.vis):current.score>=50?'score '+fmt0(current.score)+'/100 · VIS '+fmtM(current.vis)+' → brak FG':'wynik <50/100 pominięty'}</em></div>
      <div class=\"fog-card\"><small>Typ procesu</small><strong>${type}</strong><em>${peak.type?.secondary?'wtórny: '+mechanismName(peak.type.secondary):'dominujący mechanizm'}</em></div>
      <div class=\"fog-card\"><small>Kiedy FG?</small><strong>${ev.onset?localDateTime(ev.onset)+' → '+(ev.end?localDateTime(ev.end):'dalej'):'brak FG w 48 h'}</strong><em>wymagane score ≥50 i VIS &lt;1000 m</em></div>
      <div class=\"fog-card ${riskCss(peakFg?peak.score:null)}\"><small>Maksimum FG w 48 h</small><strong>${peakFg?scoreClass(peak.score):'BRAK FG'}</strong><em>${peakFg?fmt0(peak.score)+'/100 · '+(ev.peakFrom?localDateTime(ev.peakFrom)+' – '+localDateTime(ev.peakTo):localDateTime(peak.t)):'score procesu bez VIS <1000 m nie jest FG'}</em></div>
      <div class=\"fog-card\"><small>VIS &lt;1000 / &lt;500 m</small><strong>${fmt0(current.vis1000)}/100 · ${fmt0(current.vis500)}/100</strong><em>VIS EPIR ${fmtM(current.vis)}</em></div>
      <div class=\"fog-card\"><small>VIS &lt;1500 / &lt;200 m</small><strong>${fmt0(current.vis1500)}/100 · ${fmt0(current.vis200)}/100</strong><em>osobne zagrożenia</em></div>
      <div class=\"fog-card\"><small>Mgła marznąca</small><strong>${freeze}</strong><em>${peakFg?'T przy maksimum '+fmt1(peak.T)+'°C':'brak operacyjnego FG'}</em></div>
      <div class=\"fog-card\"><small>Pewność prognozy</small><strong>${confidenceLabel(current.confidence)}</strong><em>${fmt0((current.confidence??0)*100)}% wskaźnika CONF</em></div>`;"""
    if old_summary not in s:
        raise SystemExit("FOG summary semantics marker not found")
    s = s.replace(old_summary, new_summary, 1)

    old_hours = """      hours.innerHTML=future.slice(0,13).map(x=>`<div class=\"fog-hour ${riskCss(x.score)}\"><b>${localHour(x.t)}</b><div class=\"p\">${scoreClass(x.score)}</div><small>${x.score>=50?fmt0(x.score)+'/100':'&lt;50 · pominięte'}</small><small>${x.score>=50?(x.type?.text||'—'):'bez sygnału operacyjnego'}</small><small>VIS ${fmtM(x.vis)}</small><small>&lt;1km ${fmt0(x.vis1000)}/100</small></div>`).join('');"""
    new_hours = """      hours.innerHTML=future.slice(0,13).map(x=>{const fg=isOperationalFg(x);return `<div class=\"fog-hour ${riskCss(fg?x.score:null)}\"><b>${localHour(x.t)}</b><div class=\"p\">${fg?scoreClass(x.score):'NIE'}</div><small>${x.score>=50?fmt0(x.score)+'/100':'&lt;50 · pominięte'}</small><small>${fg?(x.type?.text||'—'):x.score>=50?'score bez VIS <1 km':'bez sygnału operacyjnego'}</small><small>VIS ${fmtM(x.vis)}</small><small>&lt;1km ${fmt0(x.vis1000)}/100</small></div>`;}).join('');"""
    if old_hours not in s:
        raise SystemExit("FOG hourly semantics marker not found")
    s = s.replace(old_hours, new_hours, 1)

    p.write_text(s, encoding="utf-8")


def patch_mifg() -> None:
    p = SITE / "mifg-engine.js"
    s = p.read_text(encoding="utf-8")
    old = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:PLACE.tz,hour:'2-digit',minute:'2-digit'}).format(new Date(t));}
    catch(_){return new Date(t).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});}
  }"""
    new = """  function localHour(t){
    try{return new Intl.DateTimeFormat('pl-PL',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'}).format(new Date(t))+' UTC';}
    catch(_){return String(new Date(t).getUTCHours()).padStart(2,'0')+':'+String(new Date(t).getUTCMinutes()).padStart(2,'0')+' UTC';}
  }"""
    if old not in s:
        raise SystemExit("MIFG UTC formatter marker not found")
    s = s.replace(old, new, 1)
    s = s.replace("timeZone:PLACE.tz,hour:'2-digit',hourCycle:'h23'", "timeZone:'UTC',hour:'2-digit',hourCycle:'h23'", 1)
    p.write_text(s, encoding="utf-8")


def cache_bust_bridge() -> None:
    bridge = SITE / "fog-summary-layout.js"
    b = bridge.read_text(encoding="utf-8")
    for asset in ("fog-physics-vnext.js", "fog-vnext-probability-layer.js", "fog-visibility-vnext.js"):
        b = re.sub(rf"{re.escape(asset)}\?v=[^'\"]+", f"{asset}?v={ASSET_V}", b)
    bridge.write_text(b, encoding="utf-8")


def strip_script(html: str, asset: str) -> str:
    return re.sub(
        rf'\s*<script\s+src=["\']{re.escape(asset)}(?:\?[^"\']*)?["\'][^>]*></script>',
        '',
        html,
        flags=re.I,
    )


def wire_meteogram_bridge() -> None:
    p = SITE / "index.html"
    s = p.read_text(encoding="utf-8")
    s = re.sub(r'utc-ui-guard\.js(?:\?v=[^\"]*)?', f'utc-ui-guard.js?v={ASSET_V}', s)

    # Remove every in-page Fog runtime.  The old chain let fog-engine.js see
    # meteogram globals (MODELS/datasets) and later fog-summary-layout.js could
    # overwrite the selected series.  The meteogram must only consume the
    # isolated canonical fog.html runtime.
    for asset in INDEX_FOG_RUNTIME_ASSETS:
        s = strip_script(s, asset)

    if '</body>' not in s:
        raise SystemExit("index.html body marker missing")
    provider = f'<script src="fog-index-bridge.js?v={ASSET_V}"></script>'
    overlay = f'<script src="fog-meteogram-overlay.js?v={ASSET_V}"></script>'
    s = s.replace('</body>', provider + '\n' + overlay + '\n</body>', 1)
    p.write_text(s, encoding="utf-8")


def wire_standalone_page() -> None:
    p = SITE / "fog.html"
    f = p.read_text(encoding="utf-8")
    f = re.sub(r'utc-ui-guard\.js(?:\?v=[^\"]*)?', f'utc-ui-guard.js?v={ASSET_V}', f)
    for asset in FOG_PAGE_ASSETS:
        f = re.sub(rf"{re.escape(asset)}\?v=[^'\"\s<>,)]+", f"{asset}?v={ASSET_V}", f)
    p.write_text(f, encoding="utf-8")


def validate() -> None:
    fog = (SITE / "fog-engine.js").read_text(encoding="utf-8")
    mifg = (SITE / "mifg-engine.js").read_text(encoding="utf-8")
    br = (SITE / "br-engine.js").read_text(encoding="utf-8")
    index = (SITE / "index.html").read_text(encoding="utf-8")
    index_bridge = (SITE / "fog-index-bridge.js").read_text(encoding="utf-8")
    theme = (SITE / "theme.js").read_text(encoding="utf-8")
    app_css = (SITE / "app.css").read_text(encoding="utf-8")
    bridge = (SITE / "fog-summary-layout.js").read_text(encoding="utf-8")
    probability = (SITE / "fog-vnext-probability-layer.js").read_text(encoding="utf-8")
    fog_html = (SITE / "fog.html").read_text(encoding="utf-8")

    if "timeZone:PLACE.tz" in fog or "timeZone:PLACE.tz" in mifg:
        raise SystemExit("local timezone reference remains in deployed FOG/MIFG")
    if "PrognozaEPIRFogLegacySeries" not in fog:
        raise SystemExit("dedicated LEGACY fog series is not exported for TAF")
    for marker in ("function isOperationalFg", "Kiedy FG?", "score bez VIS <1 km"):
        if marker not in fog:
            raise SystemExit(f"FOG visibility semantics missing: {marker}")

    if 'app.css?v=' not in index:
        raise SystemExit("meteogram shared stylesheet contract missing")
    if '#fogEngine' not in app_css or 'data-epir-page="index"' not in app_css:
        raise SystemExit("shared stylesheet is missing the meteogram-only Fog panel rule")
    if f'utc-ui-guard.js?v={ASSET_V}' not in index:
        raise SystemExit("global navigation runtime is not cache-busted")

    provider_tag = f'fog-index-bridge.js?v={ASSET_V}'
    overlay_tag = f'fog-meteogram-overlay.js?v={ASSET_V}'
    if index.count('fog-index-bridge.js?v=') != 1 or provider_tag not in index:
        raise SystemExit("canonical fog.html provider is missing, duplicated or cache-stale")
    if index.count('fog-meteogram-overlay.js?v=') != 1 or overlay_tag not in index:
        raise SystemExit("meteogram Fog/BR overlay is missing, duplicated or cache-stale")
    if index.find(provider_tag) > index.find(overlay_tag):
        raise SystemExit("canonical Fog provider must load before meteogram overlay")
    for asset in ("fog-engine.js", "observation-engine.js", "mifg-engine.js", "br-engine.js", "fog-summary-layout.js", "fog-mode-switch.js"):
        if re.search(rf'<script\s+src=["\']{re.escape(asset)}(?:\?[^"\']*)?["\']', index, re.I):
            raise SystemExit(f"duplicate Fog runtime leaked into meteogram: {asset}")
    for marker in (
        "frame.src='fog.html?runtime-provider=1",
        'PrognozaEPIRFogLegacySeries',
        'PrognozaEPIRFogVNextSeries',
        'PrognozaEPIRBRSeries',
        'PrognozaEPIRMIFGSeries',
    ):
        if marker not in index_bridge:
            raise SystemExit(f"canonical Fog index bridge contract missing: {marker}")

    if "fogEngineMode:'vnext-production'" not in bridge or 'Probability.operationalScore' not in bridge:
        raise SystemExit("Fog vNext bridge is not in production mode")
    for asset in ("fog-physics-vnext.js", "fog-vnext-probability-layer.js", "fog-visibility-vnext.js"):
        if f'{asset}?v={ASSET_V}' not in bridge:
            raise SystemExit(f"Fog vNext dynamic asset is not cache-busted: {asset}")
    for marker in (
        "P_model_final", "stateReadiness", "visibilityContradiction",
        "PrognozaEPIRFogRenderSeries", "const VNEXT_THRESHOLD=60", "const LEGACY_THRESHOLD=50",
    ):
        if marker not in probability:
            raise SystemExit(f"Fog vNext probability contract missing: {marker}")
    for marker in ("VERSION:'1.0.0-br-target'", "ZAMGLENIE (BR)", "BR jest osobnym targetem"):
        if marker not in br:
            raise SystemExit(f"BR target contract missing: {marker}")

    forbidden = (
        '<iframe', 'index.html?fogpanel=', 'fogRuntime', 'runtime-wrap',
        'canvasViewport', '<canvas', 'MutationObserver', 'ResizeObserver',
        'epir-pages-compat-', 'message-archive-client.js', 'observation-engine.js',
        'fog-meteogram-overlay.js', 'shortcut-mode.js',
    )
    for marker in forbidden:
        if marker in fog_html:
            raise SystemExit(f"dead/meteogram runtime leaked into fog.html: {marker}")
    for marker in (
        'id="epirGlobalNav"', 'href="index.html"', 'href="taf.html"',
        'id="fogStandaloneMount"', 'window.__PROGNOZA_EPIR_FOG_STANDALONE__=true',
    ):
        if marker not in fog_html:
            raise SystemExit(f"native EPIR FOG page marker missing: {marker}")
    for asset in FOG_PAGE_ASSETS:
        if f'{asset}?v={ASSET_V}' not in fog_html:
            raise SystemExit(f"native EPIR FOG asset missing/cache stale: {asset}")
    if '["fog.html","EPIR FOG","fog"]' not in theme:
        raise SystemExit("EPIR FOG missing from shared theme navigation")


def main() -> int:
    patch_fog()
    patch_fg_semantics()
    patch_mifg()
    cache_bust_bridge()
    wire_meteogram_bridge()
    wire_standalone_page()
    validate()
    print("wired canonical fog.html runtime provider with strict FG visibility semantics")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())