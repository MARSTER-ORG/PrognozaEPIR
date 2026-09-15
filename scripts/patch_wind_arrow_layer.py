#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch_cleanup():
    p = ROOT / 'meteogram-visfog-cleanup.js'
    s = p.read_text(encoding='utf-8')
    export = '  window.PrognozaEPIRRedrawWindForeground = redrawWindPanelForeground;\n\n'
    marker = '  function installFogHoverTooltip() {'
    if export not in s:
        if marker not in s:
            raise RuntimeError('cleanup export marker missing')
        s = s.replace(marker, export + marker, 1)
    p.write_text(s, encoding='utf-8')


def patch_overlay():
    p = ROOT / 'fog-meteogram-overlay.js'
    s = p.read_text(encoding='utf-8')
    old = '''      draw = function() {
        baseDraw();
        drawPressureFill();
        drawFogBars();
      };'''
    new = '''      draw = function() {
        baseDraw();
        drawPressureFill();
        drawFogBars();
        try {
          if (typeof window.PrognozaEPIRRedrawWindForeground === 'function') {
            window.PrognozaEPIRRedrawWindForeground();
          }
        } catch (_) { }
      };'''
    if old in s:
        s = s.replace(old, new, 1)
    elif 'window.PrognozaEPIRRedrawWindForeground();' not in s:
        raise RuntimeError('fog overlay draw wrapper marker missing')
    p.write_text(s, encoding='utf-8')


def patch_pages_cache():
    p = ROOT / 'scripts' / 'prepare_pages.py'
    s = p.read_text(encoding='utf-8')
    names = [
        'index-fixes.js',
        'axis-layout-fix.js',
        'visual-style-fix.js',
        'meteogram-layout-v2.js',
        'meteogram-visfog-split.js',
        'rh-axis-fix.js',
        'meteogram-visfog-cleanup.js',
        'day-night-fix.js',
        'observation-engine.js',
        'fog-meteogram-overlay.js',
        'shortcut-mode.js',
    ]
    for name in names:
        old = f"'<script src=\"{name}\"></script>'"
        new = f"f'<script src=\"{name}?v={{ASSET_V}}\"></script>'"
        if old in s:
            s = s.replace(old, new)
    required = [
        'meteogram-visfog-cleanup.js?v={ASSET_V}',
        'fog-meteogram-overlay.js?v={ASSET_V}',
    ]
    if not all(x in s for x in required):
        raise RuntimeError('cache bust patch incomplete')
    p.write_text(s, encoding='utf-8')


def validate():
    cleanup = (ROOT / 'meteogram-visfog-cleanup.js').read_text(encoding='utf-8')
    overlay = (ROOT / 'fog-meteogram-overlay.js').read_text(encoding='utf-8')
    pages = (ROOT / 'scripts' / 'prepare_pages.py').read_text(encoding='utf-8')
    assert 'window.PrognozaEPIRRedrawWindForeground = redrawWindPanelForeground;' in cleanup
    assert overlay.index('window.PrognozaEPIRRedrawWindForeground();') > overlay.index('drawFogBars();')
    assert 'meteogram-visfog-cleanup.js?v={ASSET_V}' in pages
    assert 'fog-meteogram-overlay.js?v={ASSET_V}' in pages


if __name__ == '__main__':
    patch_cleanup()
    patch_overlay()
    patch_pages_cache()
    validate()
    print('wind arrow final layer patch: OK')
