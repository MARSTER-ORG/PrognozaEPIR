#!/usr/bin/env python3
from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text(encoding='utf-8')
    count = s.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match in {path}, got {count}')
    p.write_text(s.replace(old, new, 1), encoding='utf-8')


# 1) map-extras.js: never install the obsolete second CAPPI implementation when
# radar-intelligence.js has already created the canonical CAPPI product button.
old = """// CAPPI diagnostic view + detailed POLRAD dBZ legend -----------------------
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  if (window.__PrognozaEPIRCappiInstalled) return;
  window.__PrognozaEPIRCappiInstalled = true;

  const $ = id => document.getElementById(id);
  const mapEl = $('map');
  const mapbar = document.querySelector('.mapbar');
  if (!mapEl || !mapbar) return;

  const style = document.createElement('style');
"""
new = """// CAPPI diagnostic view + detailed POLRAD dBZ legend -----------------------
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  if (window.__PrognozaEPIRCappiInstalled) return;

  const $ = id => document.getElementById(id);
  const mapEl = $('map');
  const mapbar = document.querySelector('.mapbar');
  if (!mapEl || !mapbar) return;

  // radar-intelligence.js is the single owner of all official POLRAD product
  // buttons and animation. If canonical CAPPI already exists, do not install
  // this older diagnostic renderer (it used to create a second polrad_cappi id).
  if ($('polrad_cappi')) return;
  window.__PrognozaEPIRCappiInstalled = true;

  const style = document.createElement('style');
"""
replace_once('map-extras.js', old, new, 'disable duplicate CAPPI renderer')

# 2) range-rings-reset.js: EHT and GRAD/hail are genuine canonical POLRAD
# products. Omitting their button ids made the layer hygiene code think that no
# radar was active and remove their ImageOverlay immediately after layeradd.
replace_once(
    'range-rings-reset.js',
    "const radarButtonIds = ['polrad_cmax','polrad_cappi','polrad_sri','polrad_pac','radarToggle'];",
    "const radarButtonIds = ['polrad_cmax','polrad_cappi','polrad_eht','polrad_sri','polrad_pac','polrad_hail','radarToggle'];",
    'recognize all POLRAD product buttons',
)

# 3) opera-convection-bridge.js: keep the useful convection/fetch bridge, but
# do not create a second OPERA map renderer when opera-nowcast.js is already the
# canonical synchronized/reprojected map owner.
p = Path('opera-convection-bridge.js')
s = p.read_text(encoding='utf-8')
marker = '// Robust OPERA CMAX map renderer -------------------------------------------'
pos = s.find(marker)
if pos < 0:
    raise RuntimeError('OPERA map renderer marker missing')
head, tail = s[:pos], s[pos:]
old2 = "  if (!/\\/radar\\.html$/i.test(location.pathname)) return;\n  if (window.__epirOperaMapLayerFixV2) return;"
new2 = "  if (!/\\/radar\\.html$/i.test(location.pathname)) return;\n  // opera-nowcast.js already owns the time-synchronized, reprojected OPERA map.\n  // Keep this legacy renderer disabled to avoid two layers/listeners fighting.\n  if (window.PrognozaEPIROperaNowcastEngine) return;\n  if (window.__epirOperaMapLayerFixV2) return;"
if tail.count(old2) != 1:
    raise RuntimeError(f'disable duplicate OPERA renderer: expected one match, got {tail.count(old2)}')
tail = tail.replace(old2, new2, 1)
p.write_text(head + tail, encoding='utf-8')

# 4) lightning-layer.js: make a dead/stale LFL source explicit in the toolbar
# instead of letting the user enable an empty layer. A valid zero-flash result
# remains enabled because status=ok is a legitimate observation.
p = Path('lightning-layer.js')
s = p.read_text(encoding='utf-8')
needle = """  function toggleOverlay(){return setOverlay(!overlayActive);}
  function ensureMapButton(){
"""
replacement = """  function toggleOverlay(){return setOverlay(!overlayActive);}
  function syncMapButtonAvailability(){
    const b=$('lightningToggle');if(!b)return;
    const ok=features?.status==='ok'&&freshness(features);
    b.disabled=!ok;
    b.dataset.available=ok?'1':'0';
    if(!ok&&overlayActive)setOverlay(false);
    b.title=ok
      ? `Rzeczywiste wyładowania EUMETSAT MTG LI LFL · dane ${formatUtc(features.updated_at)}`
      : `Wyładowania LFL chwilowo niedostępne${features?.reason?': '+String(features.reason).slice(0,120):''}`;
  }
  function ensureMapButton(){
"""
if s.count(needle) != 1:
    raise RuntimeError(f'lightning availability helper insertion: {s.count(needle)} matches')
s = s.replace(needle, replacement, 1)

old_success = """      features=j;lastFetch=Date.now();window.PrognozaEPIRLightningFeatures=features;removeLegacyAfa();renderOverlay();renderPanel();updateConvectionTile(evidence(window.PrognozaEPIRConvectionNowcast||{}));
"""
new_success = """      features=j;lastFetch=Date.now();window.PrognozaEPIRLightningFeatures=features;removeLegacyAfa();syncMapButtonAvailability();renderOverlay();renderPanel();updateConvectionTile(evidence(window.PrognozaEPIRConvectionNowcast||{}));
"""
if s.count(old_success) != 1:
    raise RuntimeError(f'lightning success hook: {s.count(old_success)} matches')
s = s.replace(old_success, new_success, 1)
old_error = """      features={schema:'prognozaepir-lightning-features-v1',status:'error',updated_at:new Date().toISOString(),reason:String(err)};window.PrognozaEPIRLightningFeatures=features;renderPanel();updateConvectionTile();return features;
"""
new_error = """      features={schema:'prognozaepir-lightning-features-v1',status:'error',updated_at:new Date().toISOString(),reason:String(err)};window.PrognozaEPIRLightningFeatures=features;syncMapButtonAvailability();renderPanel();updateConvectionTile();return features;
"""
if s.count(old_error) != 1:
    raise RuntimeError(f'lightning error hook: {s.count(old_error)} matches')
s = s.replace(old_error, new_error, 1)
p.write_text(s, encoding='utf-8')

# 5) Every radar runtime script in the canonical Pages artifact gets the build
# SHA query parameter. Previously several key files (including radar-intelligence
# and map-extras) were re-added without cache busting by prepare_pages.py.
p = Path('scripts/prepare_pages.py')
s = p.read_text(encoding='utf-8')
s = s.replace('RADAR_VERSION = "RADAR / SAT / AI v0.12.3"', 'RADAR_VERSION = "RADAR / SAT / AI v0.12.5"')
old_addons = """    addons = [
        '<script src=\"radar-enhance.js\"></script>',
        '<script src=\"warnings-readable.js\"></script>',
        '<script src=\"radar-intelligence.js\"></script>',
        '<script src=\"echo-analysis.js\"></script>',
        '<script src=\"echo-fix.js\"></script>',
        '<script src=\"lightning-layer.js\"></script>',
        '<script src=\"ui-cleanup.js\"></script>',
        '<script src=\"map-extras.js\"></script>',
        '<script src=\"analysis-plus.js\"></script>',
        '<script src=\"range-rings-reset.js\"></script>',
        f'<script src=\"opera-nowcast.js?v={ASSET_V}\"></script>',
        f'<script src=\"opera-convection-bridge.js?v={ASSET_V}\"></script>',
        f'<script src=\"radar-risk-policy.js?v={ASSET_V}\"></script>',
        '<script src=\"shortcut-mode.js\"></script>',
    ]
"""
new_addons = """    addons = [
        f'<script src=\"radar-enhance.js?v={ASSET_V}\"></script>',
        f'<script src=\"warnings-readable.js?v={ASSET_V}\"></script>',
        f'<script src=\"radar-intelligence.js?v={ASSET_V}\"></script>',
        f'<script src=\"echo-analysis.js?v={ASSET_V}\"></script>',
        f'<script src=\"echo-fix.js?v={ASSET_V}\"></script>',
        f'<script src=\"lightning-layer.js?v={ASSET_V}\"></script>',
        f'<script src=\"ui-cleanup.js?v={ASSET_V}\"></script>',
        f'<script src=\"map-extras.js?v={ASSET_V}\"></script>',
        f'<script src=\"analysis-plus.js?v={ASSET_V}\"></script>',
        f'<script src=\"range-rings-reset.js?v={ASSET_V}\"></script>',
        f'<script src=\"opera-nowcast.js?v={ASSET_V}\"></script>',
        f'<script src=\"opera-convection-bridge.js?v={ASSET_V}\"></script>',
        f'<script src=\"radar-risk-policy.js?v={ASSET_V}\"></script>',
        f'<script src=\"shortcut-mode.js?v={ASSET_V}\"></script>',
    ]
"""
if s.count(old_addons) != 1:
    raise RuntimeError(f'prepare_pages radar addons: expected one match, got {s.count(old_addons)}')
s = s.replace(old_addons, new_addons, 1)

# Validate the canonical artifact contract as well: important runtimes must be
# cache-busted and the legacy duplicate CAPPI must be disabled in its JS file.
old_validation = """    radar = rd(SITE / \"radar.html\")
    if \"radar-risk-policy.js\" not in radar or \"lightning-alerts.html\" not in radar:
        raise RuntimeError(\"radar risk policy or lightning alert page not wired\")
"""
new_validation = """    radar = rd(SITE / \"radar.html\")
    if \"radar-risk-policy.js\" not in radar or \"lightning-alerts.html\" not in radar:
        raise RuntimeError(\"radar risk policy or lightning alert page not wired\")
    for runtime in (\"radar-intelligence.js\", \"map-extras.js\", \"lightning-layer.js\", \"range-rings-reset.js\"):
        if not re.search(rf'src=\"{re.escape(runtime)}\\?v=[^\"]+\"', radar):
            raise RuntimeError(f\"radar runtime is not cache-busted: {runtime}\")
    map_extras = rd(SITE / \"map-extras.js\")
    if \"if ($('polrad_cappi')) return;\" not in map_extras:
        raise RuntimeError(\"legacy duplicate CAPPI renderer is not guarded\")
"""
if s.count(old_validation) != 1:
    raise RuntimeError(f'prepare_pages radar validation: expected one match, got {s.count(old_validation)}')
s = s.replace(old_validation, new_validation, 1)
p.write_text(s, encoding='utf-8')

print('radar layer reliability patch applied')
