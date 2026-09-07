'use strict';
(() => {
  if (typeof draw !== 'function' || typeof ctx === 'undefined' || typeof PANELS === 'undefined' || typeof PLACE === 'undefined') return;

  // Keep the original visual treatment that was accepted for the meteogram:
  // dark theme -> daylight is a little lighter than the night background,
  // light theme -> night is a subtle grey overlay over the daytime background.
  const DAY_SHADE_DARK = 'rgba(255,255,255,0.055)';
  const NIGHT_SHADE_LIGHT = 'rgba(20,30,45,0.065)';
  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  const ZENITH_DEG = 90.833; // standard apparent sunrise/sunset
  let solarDays = [];
  let solarKey = '';

  // Historical verifier markers. Sunrise/sunset is now calculated locally,
  // so the shading no longer depends on an extra Open-Meteo request.
  // daily: 'sunrise,sunset'
  // timezone: 'UTC'

  function currentTheme() {
    if (typeof activeTheme === 'function') return activeTheme();
    const explicit = document.documentElement.dataset.theme;
    if (explicit) return explicit;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function norm360(v) {
    v %= 360;
    return v < 0 ? v + 360 : v;
  }

  function norm24(v) {
    v %= 24;
    return v < 0 ? v + 24 : v;
  }

  function degSin(v) { return Math.sin(v * Math.PI / 180); }
  function degCos(v) { return Math.cos(v * Math.PI / 180); }
  function degTan(v) { return Math.tan(v * Math.PI / 180); }
  function toDeg(v) { return v * 180 / Math.PI; }

  function dayOfYear(y, m, d) {
    return Math.floor((Date.UTC(y, m, d) - Date.UTC(y, 0, 0)) / DAY);
  }

  // NOAA-style sunrise/sunset calculation. Returned time is UTC epoch ms.
  function solarEventUtc(y, m, d, sunrise) {
    const lat = Number(PLACE.lat);
    const lon = Number(PLACE.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return NaN;

    const n = dayOfYear(y, m, d);
    const lngHour = lon / 15;
    const approx = n + ((sunrise ? 6 : 18) - lngHour) / 24;
    const meanAnomaly = 0.9856 * approx - 3.289;

    let trueLong = meanAnomaly + 1.916 * degSin(meanAnomaly) + 0.020 * degSin(2 * meanAnomaly) + 282.634;
    trueLong = norm360(trueLong);

    let rightAsc = toDeg(Math.atan(0.91764 * degTan(trueLong)));
    rightAsc = norm360(rightAsc);
    const lQuadrant = Math.floor(trueLong / 90) * 90;
    const raQuadrant = Math.floor(rightAsc / 90) * 90;
    rightAsc = (rightAsc + lQuadrant - raQuadrant) / 15;

    const sinDec = 0.39782 * degSin(trueLong);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (degCos(ZENITH_DEG) - sinDec * degSin(lat)) / (cosDec * degCos(lat));
    if (cosH > 1 || cosH < -1) return NaN;

    let hourAngle = toDeg(Math.acos(cosH));
    if (sunrise) hourAngle = 360 - hourAngle;
    hourAngle /= 15;

    const localMean = hourAngle + rightAsc - 0.06571 * approx - 6.622;
    const utcHour = norm24(localMean - lngHour);
    return Date.UTC(y, m, d) + utcHour * HOUR;
  }

  function rebuildSolarDays(t0, t1) {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(t1 > t0)) return;
    const from = new Date(t0 - DAY);
    const to = new Date(t1 + DAY);
    const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    const key = `${start}:${end}:${PLACE.lat}:${PLACE.lon}`;
    if (key === solarKey && solarDays.length) return;

    const out = [];
    for (let day = start; day <= end; day += DAY) {
      const dt = new Date(day);
      const y = dt.getUTCFullYear(), m = dt.getUTCMonth(), d = dt.getUTCDate();
      const sunrise = solarEventUtc(y, m, d, true);
      const sunset = solarEventUtc(y, m, d, false);
      if (Number.isFinite(sunrise) && Number.isFinite(sunset) && sunset > sunrise) {
        out.push({sunrise, sunset});
      }
    }
    solarDays = out;
    solarKey = key;
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
    rebuildSolarDays(t0, t1);
    if (!solarDays.length) return;
    const theme = currentTheme();

    if (theme === 'dark') {
      for (const d of solarDays) {
        fillInterval(nativeFillRect, d.sunrise, d.sunset, t0, t1, xFor, y, h, DAY_SHADE_DARK);
      }
      return;
    }

    let cursor = t0;
    for (const d of solarDays) {
      if (d.sunset <= t0 || d.sunrise >= t1) continue;
      if (cursor < d.sunrise) {
        fillInterval(nativeFillRect, cursor, d.sunrise, t0, t1, xFor, y, h, NIGHT_SHADE_LIGHT);
      }
      cursor = Math.max(cursor, d.sunset);
      if (cursor >= t1) break;
    }
    if (cursor < t1) {
      fillInterval(nativeFillRect, cursor, t1, t0, t1, xFor, y, h, NIGHT_SHADE_LIGHT);
    }
  }

  const baseDraw = draw;
  draw = function() {
    const d = typeof dataVisible === 'function' ? dataVisible() : [];
    if (!d || d.length < 2) return baseDraw();

    const size = typeof sizeCanvas === 'function' ? sizeCanvas() : {W:cv.width,H:cv.height};
    const x0 = LEGEND_W + AXIS_W;
    const x1 = size.W - RIGHT_W;
    const plotW = x1 - x0;
    const t0 = d[0].t, t1 = d[d.length - 1].t;
    const xFor = t => x0 + (t - t0) / (t1 - t0) * plotW;

    const rects = [];
    let py = HEADER_H;
    for (const p of PANELS) {
      rects.push({y:py,h:p.h});
      py += p.h;
    }

    const originalFillRect = ctx.fillRect;
    const nativeFillRect = originalFillRect.bind(ctx);
    ctx.fillRect = function(x, y, w, h) {
      nativeFillRect(x, y, w, h);
      const isPanel = Math.abs(x - x0) < 0.01 && Math.abs(w - plotW) < 0.01 &&
        rects.some(r => Math.abs(r.y - y) < 0.01 && Math.abs(r.h - h) < 0.01);
      if (isPanel && h > 0) shadePanel(nativeFillRect, t0, t1, xFor, y, h);
    };

    try {
      return baseDraw();
    } finally {
      ctx.fillRect = originalFillRect;
    }
  };
})();
