from pathlib import Path

p = Path('radar-intelligence.js')
s = p.read_text(encoding='utf-8')
old = """    if (!polradLayer) {\n      polradLayer = L.imageOverlay(url, POLRAD_BOUNDS, {\n        pane:POLRAD_PANE, opacity:0, interactive:false, crossOrigin:true,\n        attribution:'IMGW-PIB / POLRAD'\n      });\n      polradLayer.once('load', onLoad);\n      polradLayer.once('error', onError);\n      if (active) polradLayer.addTo(map);\n    } else {\n      polradLayer.setOpacity(0);\n      polradLayer.setBounds(POLRAD_BOUNDS);\n      polradLayer.once('load', onLoad);\n      polradLayer.once('error', onError);\n      polradLayer.setUrl(url);\n      if (active && !map.hasLayer(polradLayer)) polradLayer.addTo(map);\n    }\n"""
new = """    // Hard-swap frames. Never reuse the previous IMG element: on some browsers\n    // a setUrl() swap can keep the decoded previous bitmap visible while the next\n    // image is loading, which looks like a frozen first frame under the animation.\n    // Purging every POLRAD ImageOverlay guarantees exactly one radar frame on map.\n    removePolradLayer();\n    polradLayer = L.imageOverlay(url, POLRAD_BOUNDS, {\n      pane:POLRAD_PANE, opacity:.70, interactive:false, crossOrigin:true,\n      attribution:'IMGW-PIB / POLRAD'\n    });\n    polradLayer.once('load', onLoad);\n    polradLayer.once('error', onError);\n    if (active) polradLayer.addTo(map);\n"""
if old not in s:
    raise SystemExit('target POLRAD swap block not found')
s = s.replace(old, new, 1)
s = s.replace('// PrognozaEPIR v0.11.2', '// PrognozaEPIR v0.11.3', 1)
s = s.replace("version.textContent = 'RADAR / SAT / AI v0.11.2'", "version.textContent = 'RADAR / SAT / AI v0.11.3'", 1)
p.write_text(s, encoding='utf-8')

p = Path('radar.html')
s = p.read_text(encoding='utf-8')
s = s.replace('radar-sync-v3', 'radar-sync-v5')
p.write_text(s, encoding='utf-8')

print('POLRAD hard-swap animation + cache bust applied')
