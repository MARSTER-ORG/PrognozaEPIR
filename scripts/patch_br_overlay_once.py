#!/usr/bin/env python3
from pathlib import Path
import re

p = Path('fog-meteogram-overlay.js')
s = p.read_text(encoding='utf-8')

pattern = re.compile(r"  function brSeries\(\) \{\n.*?\n  \}\n  function brAt", re.S)
replacement = """  function brSeries() {
    // Meteogram BR is derived directly with the same authoritative scorer as
    // the BR panel. This avoids startup races and stale global BR series.
    try {
      const engine = window.PrognozaEPIRBREngine;
      const src = fogSeries();
      if (engine?.scoreRow && Array.isArray(src) && src.length) {
        const now = Date.now();
        const direct = src
          .map(row => engine.scoreRow(row, 'legacy', now))
          .filter(row => row && finite(Number(row.t)) && finite(Number(row.score)))
          .sort((a,b) => Number(a.t)-Number(b.t));
        if (direct.length) return direct;
      }
    } catch (_) { }

    const published = window.PrognozaEPIRBRSeries;
    if (Array.isArray(published) && published.length) {
      return published
        .filter(row => row && finite(Number(row.t)) && finite(Number(row.score)))
        .slice().sort((a,b) => Number(a.t)-Number(b.t));
    }
    return fogSeries().map(row => {
      const score = brScoreForFogRow(row);
      return finite(score) ? {...row,score} : null;
    }).filter(Boolean);
  }
  function brAt"""
s2, n = pattern.subn(replacement, s, count=1)
if n != 1:
    raise SystemExit(f'BR series block replacement failed: {n}')
s = s2

old = """    ctx.setLineDash([]);

    const cp=typeof canvasPalette==='function'?canvasPalette():{muted:'#666',grid2:'#999'};"""
marker = """    ctx.setLineDash([]);

    // Make BR explicit on small/mobile meteograms: purple diamonds + score.
    ctx.font='bold 7.5px Arial';ctx.textAlign='center';ctx.textBaseline='bottom';
    for(const row of br){
      const score=Number(row.score),xx=x(Number(row.t)),yy=yOnRiskScale(score,p),r=4.1;
      ctx.save();ctx.translate(xx,yy);ctx.rotate(Math.PI/4);ctx.fillStyle='rgba(192,132,252,.96)';ctx.strokeStyle='rgba(248,240,255,.98)';ctx.lineWidth=1;ctx.fillRect(-r,-r,2*r,2*r);ctx.strokeRect(-r,-r,2*r,2*r);ctx.restore();
      ctx.fillStyle='rgba(218,180,255,.99)';ctx.fillText('BR '+String(Math.round(score)),xx,yy-7);
    }

    const cp=typeof canvasPalette==='function'?canvasPalette():{muted:'#666',grid2:'#999'};"""
if old not in s:
    raise SystemExit('BR marker insertion point missing')
s = s.replace(old, marker, 1)
s = s.replace("window.__EPIR_FOG_METEOGRAM_OVERLAY_VERSION__='2026-09-18-panel-sync2';", "window.__EPIR_FOG_METEOGRAM_OVERLAY_VERSION__='2026-09-18-panel-sync3';")
p.write_text(s, encoding='utf-8')

idx = Path('index.html')
h = idx.read_text(encoding='utf-8')
oldref = 'fog-meteogram-overlay.js?v=20260918-panel-sync2'
newref = 'fog-meteogram-overlay.js?v=20260918-panel-sync3'
if oldref not in h:
    raise SystemExit('index overlay cache-bust marker missing')
idx.write_text(h.replace(oldref, newref, 1), encoding='utf-8')

print('patched BR meteogram overlay to authoritative direct scoring')
