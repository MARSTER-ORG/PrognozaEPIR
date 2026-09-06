'use strict';
(() => {
  if (typeof draw !== 'function' || typeof ctx === 'undefined' || typeof PANELS === 'undefined' || typeof PLACE === 'undefined') return;

  const VERSION = 'v0.10.16 HTML';
  const DAY_SHADE_DARK = 'rgba(255,255,255,0.055)';
  const NIGHT_SHADE_LIGHT = 'rgba(20,30,45,0.065)';
  let solarDays = [];
  let loading = false;

  function parseUtcIso(value) {
    if (!value) return NaN;
    return Date.parse(value.endsWith('Z') ? value : value + 'Z');
  }

  function currentTheme() {
    if (typeof activeTheme === 'function') return activeTheme();
    const explicit = document.documentElement.dataset.theme;
    if (explicit) return explicit;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  async function loadSolarDays() {
    if (loading) return;
    loading = true;
    try {
      const q = new URLSearchParams({
        latitude: String(PLACE.lat),
        longitude: String(PLACE.lon),
        daily: 'sunrise,sunset',
        timezone: 'UTC',
        forecast_days: '7'
      });
      const r = await fetch('https://api.open-meteo.com/v1/forecast?' + q, {cache:'no-store'});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const sr = j?.daily?.sunrise || [];
      const ss = j?.daily?.sunset || [];
      solarDays = sr.map((value,i) => ({sunrise:parseUtcIso(value), sunset:parseUtcIso(ss[i])}))
        .filter(d => Number.isFinite(d.sunrise) && Number.isFinite(d.sunset) && d.sunset > d.sunrise)
        .sort((a,b) => a.sunrise - b.sunrise);
      if (solarDays.length) draw();
    } catch (e) {
      console.warn('PrognozaEPIR day/night:', e);
    } finally {
      loading = false;
    }
  }

  function fillInterval(nativeFillRect, tA, tB, t0, t1, xFor, y, h, color) {
    const a = Math.max(tA, t0), b = Math.min(tB, t1);
    if (!(b > a)) return;
    const xa = xFor(a), xb = xFor(b);
    if (!(xb > xa)) return;
    ctx.save();
    ctx.fillStyle = color;
    nativeFillRect(xa, y, xb - xa, h);
    ctx.restore();
  }

  function shadePanel(nativeFillRect, t0, t1, xFor, y, h) {
    if (!solarDays.length) return;
    const theme = currentTheme();

    if (theme === 'dark') {
      for (const d of solarDays) fillInterval(nativeFillRect, d.sunrise, d.sunset, t0, t1, xFor, y, h, DAY_SHADE_DARK);
      return;
    }

    let cursor = t0;
    for (const d of solarDays) {
      if (d.sunset <= t0 || d.sunrise >= t1) continue;
      if (cursor < d.sunrise) fillInterval(nativeFillRect, cursor, d.sunrise, t0, t1, xFor, y, h, NIGHT_SHADE_LIGHT);
      cursor = Math.max(cursor, d.sunset);
      if (cursor >= t1) break;
    }
    if (cursor < t1) fillInterval(nativeFillRect, cursor, t1, t0, t1, xFor, y, h, NIGHT_SHADE_LIGHT);
  }

  const baseDraw = draw;
  draw = function() {
    const d = typeof dataVisible === 'function' ? dataVisible() : [];
    if (!d || d.length < 2) return baseDraw();

    const size = typeof sizeCanvas === 'function' ? sizeCanvas() : {W:cv.width,H:cv.height};
    const x0 = LEGEND_W + AXIS_W;
    const x1 = size.W - RIGHT_W;
    const plotW = x1 - x0;
    const t0 = d[0].t, t1 = d[d.length-1].t;
    const xFor = t => x0 + (t - t0) / (t1 - t0) * plotW;

    const rects = [];
    let py = HEADER_H;
    for (const p of PANELS) {
      rects.push({y:py,h:p.h});
      py += p.h;
    }

    const originalFillRect = ctx.fillRect;
    const nativeFillRect = originalFillRect.bind(ctx);
    ctx.fillRect = function(x,y,w,h) {
      nativeFillRect(x,y,w,h);
      const isPanel = Math.abs(x-x0) < 0.01 && Math.abs(w-plotW) < 0.01 && rects.some(r => Math.abs(r.y-y) < 0.01 && Math.abs(r.h-h) < 0.01);
      if (isPanel) shadePanel(nativeFillRect, t0, t1, xFor, y, h);
    };

    try {
      return baseDraw();
    } finally {
      ctx.fillRect = originalFillRect;
    }
  };

  const version = document.querySelector('.brand small');
  if (version) version.textContent = VERSION;

  loadSolarDays();
})();
