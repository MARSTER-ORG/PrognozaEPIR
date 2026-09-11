'use strict';
(() => {
  if (!/\/taf\.html$/i.test(location.pathname)) return;

  // TAF 11.2023:
  // 3.5.3: VRB przy braku możliwości podania kierunku i V < 3 KT.
  // 3.8.7: 1. grupa chmur — dowolna ilość; 2. — >2/8; 3. — >4/8.
  // 3.8.9-3.8.10: zwykłe chmury >=5000 ft nie są kodowane jako istotne;
  // CB/TCU pozostają niezależnie od wysokości.
  const FT_PER_M = 3.28084;
  const KT_PER_MS = 1.94384;
  const NSC_LIMIT_FT = 5000;
  const ORDINARY_MAX_M = NSC_LIMIT_FT / FT_PER_M;
  const BASE_CLOUD_DOMINANCE = 0.50;
  const VRB02_SHARE = 0.75;
  const VRB02_OTHER_MAX_KT = 10;
  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad = (v, n = 2) => String(Math.round(v)).padStart(n, '0');

  let applying = false;
  let queued = false;
  let lastOutput = '';

  function amountCode(okta) {
    const o = clamp(Math.round(okta), 0, 8);
    if (o <= 0) return null;
    if (o <= 2) return 'FEW';
    if (o <= 4) return 'SCT';
    if (o <= 7) return 'BKN';
    return 'OVC';
  }

  function amountMinOkta(code) {
    return code === 'FEW' ? 1 : code === 'SCT' ? 3 : code === 'BKN' ? 5 : code === 'OVC' ? 8 : 0;
  }

  function parseCloud(token) {
    const m = String(token || '').match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/);
    return m ? {raw:m[0], amount:m[1], ft:Number(m[2]) * 100, type:m[3] || ''} : null;
  }

  function parseWind(token) {
    const m = String(token || '').match(/^(VRB|\d{3})(\d{2,3})(?:G(P99|\d{2,3}))?KT$/);
    if (!m) return null;
    return {raw:m[0], vrb:m[1] === 'VRB', dir:m[1] === 'VRB' ? null : Number(m[1]), speed:Number(m[2]), gust:m[3] ? (m[3] === 'P99' ? 100 : Number(m[3])) : null};
  }

  function monthTime(code, ref, minutes = false) {
    if (!/^\d{4,6}$/.test(String(code || ''))) return NaN;
    const d = +String(code).slice(0, 2), h = +String(code).slice(2, 4), mi = minutes ? +String(code).slice(4, 6) : 0;
    const R = new Date(ref), candidates = [];
    for (let dm = -1; dm <= 1; dm++) candidates.push(Date.UTC(R.getUTCFullYear(), R.getUTCMonth() + dm, d, h, mi));
    return candidates.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref))[0];
  }

  function tafTimes(raw) {
    const issue = String(raw).match(/\b(\d{6})Z\b/);
    const validity = String(raw).match(/\b(\d{4})\/(\d{4})\b/);
    if (!issue || !validity) return null;
    const issueMs = monthTime(issue[1], Date.now(), true);
    const start = monthTime(validity[1], issueMs);
    let end = monthTime(validity[2], start + 6 * 3600e3);
    if (end <= start) end = monthTime(validity[2], start + 18 * 3600e3);
    return {issue:issueMs, start, end};
  }

  function getSeries(times) {
    const frame = $('engine');
    const w = frame?.contentWindow;
    if (!w) return [];
    try {
      const data = w.eval(`consensus.map(z=>({t:z.t,WS:z.WS,WD:z.WD,G:z.G,count:z.count,ceiling:z.ceiling,lowH:z.lowH,midH:z.midH,highH:z.highH,oktaL:z.oktaL,oktaM:z.oktaM,oktaH:z.oktaH}))`);
      return Array.isArray(data) ? data.filter(z => finite(z?.t) && z.t >= times.start && z.t < times.end) : [];
    } catch (_) {
      return [];
    }
  }

  function cloudBandFt(ft) {
    const p = [200, 300, 500, 1000, 1500];
    if (!finite(ft)) return p.length;
    for (let i = 0; i < p.length; i++) if (ft < p[i]) return i;
    return p.length;
  }

  function rowCloudState(z) {
    const layers = [
      {o:Number(z?.oktaL), h:Number(z?.lowH)},
      {o:Number(z?.oktaM), h:Number(z?.midH)},
      {o:Number(z?.oktaH), h:Number(z?.highH)}
    ].filter(x => finite(x.o) && x.o > 0 && finite(x.h));
    const bkn = layers.filter(x => x.o >= 5).sort((a,b) => a.h - b.h)[0];
    const ceilFt = bkn ? bkn.h * FT_PER_M : (finite(Number(z?.ceiling)) ? Number(z.ceiling) * FT_PER_M : NaN);
    const lowCat = layers.some(x => x.o >= 5 && x.h * FT_PER_M < 1500);
    return {ceilFt, lowCat};
  }

  function firstSignificantCloudChange(series) {
    if (!series.length) return Infinity;
    const base = rowCloudState(series[0]);
    for (let i = 1; i < series.length; i++) {
      const a = rowCloudState(series[i]);
      const changed = cloudBandFt(base.ceilFt) !== cloudBandFt(a.ceilFt) || base.lowCat !== a.lowCat;
      if (!changed) continue;
      const b = i + 1 < series.length ? rowCloudState(series[i + 1]) : a;
      const persists = cloudBandFt(base.ceilFt) !== cloudBandFt(b.ceilFt) || base.lowCat !== b.lowCat;
      if (persists) return series[i].t;
    }
    return Infinity;
  }

  function baseCloudRepresentatives(series) {
    if (!series.length) return [];
    const stop = firstSignificantCloudChange(series);
    const scope = series.filter(z => z.t < stop);
    if (!scope.length) return [];

    const hourWeights = scope.map(z => finite(Number(z.count)) ? clamp(Number(z.count) / 8, 0.75, 1.25) : 1);
    const totalW = hourWeights.reduce((a,b) => a + b, 0) || 1;
    const samples = [];

    scope.forEach((z, i) => {
      const candidates = [
        {o:Number(z.oktaL), h:Number(z.lowH)},
        {o:Number(z.oktaM), h:Number(z.midH)},
        {o:Number(z.oktaH), h:Number(z.highH)}
      ];
      for (const c of candidates) {
        if (!finite(c.o) || c.o <= 0 || !finite(c.h)) continue;
        if (c.h < 0 || c.h >= ORDINARY_MAX_M) continue;
        samples.push({o:clamp(c.o,0,8), h:c.h, i, w:hourWeights[i]});
      }
    });
    if (!samples.length) return [];

    samples.sort((a,b) => a.h - b.h);
    const clusters = [];
    for (const s of samples) {
      let best = null, bestD = Infinity;
      for (const c of clusters) {
        const d = Math.abs(s.h - c.meanH);
        if (d < 350 && d < bestD) { best = c; bestD = d; }
      }
      if (!best) { best = {samples:[], meanH:s.h}; clusters.push(best); }
      best.samples.push(s);
      const den = best.samples.reduce((a,q) => a + q.w * Math.max(1,q.o), 0) || 1;
      best.meanH = best.samples.reduce((a,q) => a + q.h * q.w * Math.max(1,q.o), 0) / den;
    }

    const reps = clusters.map(c => {
      const byHour = new Map();
      for (const s of c.samples) {
        const prev = byHour.get(s.i);
        if (!prev || s.o > prev.o) byHour.set(s.i, s);
      }
      let coverNum = 0, presentW = 0, hNum = 0, hDen = 0;
      scope.forEach((z, i) => {
        const s = byHour.get(i), w = hourWeights[i];
        if (!s) return;
        coverNum += s.o * w;
        presentW += w;
        hNum += s.h * w * Math.max(1,s.o);
        hDen += w * Math.max(1,s.o);
      });
      const avgOkta = coverNum / totalW;
      const presence = presentW / totalW;
      const hM = hDen ? hNum / hDen : NaN;
      const code = amountCode(avgOkta);
      if (!code || presence <= BASE_CLOUD_DOMINANCE || !finite(hM)) return null;
      const ft100 = clamp(Math.round(hM * FT_PER_M / 100), 1, 49);
      return {code, avgOkta, presence, hM, ft:ft100 * 100, token:code + pad(ft100,3)};
    }).filter(Boolean).sort((a,b) => a.hM - b.hM);

    // Instrukcja 3.8.7: najpierw porządkujemy rzeczywiste warstwy wg podstawy,
    // dopiero potem stosujemy progi ilościowe dla pozycji 1/2/3.
    const out = [];
    if (reps[0]) out.push(reps[0]);
    for (let i = 1; i < reps.length && out.length < 3; i++) {
      const need = out.length === 1 ? 2 : 4;
      if (reps[i].avgOkta > need) out.push(reps[i]);
    }
    return out;
  }

  function selectCloudTokens(tokens) {
    const parsed = tokens.map(parseCloud).filter(Boolean).filter(c => c.type || c.ft < NSC_LIMIT_FT);
    if (!parsed.length) return [];
    const ordinary = parsed.filter(c => !c.type).sort((a,b) => a.ft - b.ft);
    const conv = parsed.filter(c => c.type).sort((a,b) => a.ft - b.ft);
    const out = [];
    if (ordinary[0]) out.push(ordinary[0]);
    if (ordinary.length > 1) {
      const second = ordinary.slice(1).find(c => amountMinOkta(c.amount) > 2);
      if (second) out.push(second);
    }
    if (ordinary.length > 1) {
      const used = new Set(out.map(c => c.raw));
      const third = ordinary.filter(c => !used.has(c.raw)).find(c => amountMinOkta(c.amount) > 4);
      if (third) out.push(third);
    }
    for (const c of conv) if (!out.some(x => x.raw === c.raw)) out.push(c);
    return out.sort((a,b) => a.ft - b.ft).map(c => c.raw);
  }

  function isWx(token) {
    const t = String(token || '').replace(/^[-+]/,'');
    return /^(?:FG|FZFG|BR|HZ|RA|DZ|SN|SHRA|SHSN|TS|TSRA|FZRA|FZDZ|MIFG|BCFG|PRFG)$/.test(t);
  }

  function normalizeCloudLine(line, baseReps, isBase) {
    const clean = String(line || '').replace(/=$/, '').trim();
    if (!clean) return clean;
    let tokens = clean.split(/\s+/);
    const cloudTokens = tokens.filter(t => parseCloud(t));
    const conv = cloudTokens.filter(t => parseCloud(t)?.type);

    if (isBase && Array.isArray(baseReps)) {
      tokens = tokens.filter(t => !parseCloud(t) || parseCloud(t)?.type);
      tokens = tokens.filter(t => t !== 'NSC');
      const rebuilt = baseReps.map(r => r.token);
      const selected = selectCloudTokens([...rebuilt, ...conv]);
      tokens = tokens.filter(t => !parseCloud(t)).concat(selected);
    } else if (cloudTokens.length) {
      const selected = selectCloudTokens(cloudTokens);
      tokens = tokens.filter(t => !parseCloud(t)).concat(selected);
    }

    const cloudsNow = tokens.filter(t => parseCloud(t));
    const ordinary = cloudsNow.map(parseCloud).filter(c => c && !c.type && c.ft < NSC_LIMIT_FT);
    const convNow = cloudsNow.map(parseCloud).filter(c => c?.type);
    const wx = tokens.some(isWx);
    const visToken = tokens.find(t => /^\d{4}$/.test(t));
    const vis9999 = !visToken || visToken === '9999';

    if (cloudsNow.length) tokens = tokens.filter(t => t !== 'NSC');
    if (tokens.includes('CAVOK') && cloudsNow.length) {
      tokens = tokens.filter(t => t !== 'CAVOK');
      if (!tokens.some(t => /^\d{4}$/.test(t))) tokens.push('9999');
    }

    if (isBase && !ordinary.length && !convNow.length) {
      tokens = tokens.filter(t => t !== 'NSC' && t !== 'CAVOK');
      if (!wx && vis9999) {
        tokens = tokens.filter(t => t !== '9999');
        tokens.push('CAVOK');
      } else {
        if (!tokens.includes('NSC')) tokens.push('NSC');
      }
    }

    // Porządek elementów pozostawia pierwotny generator; chmury są na końcu.
    const nonCloud = tokens.filter(t => !parseCloud(t));
    const finalClouds = selectCloudTokens(tokens.filter(t => parseCloud(t)));
    return [...nonCloud, ...finalClouds].filter((t,i,a) => t && a.indexOf(t) === i).join(' ').replace(/\s+/g,' ').trim();
  }

  function encodedEvenSpeedKt(z) {
    const raw = Number(z?.WS) * KT_PER_MS;
    if (!finite(raw)) return NaN;
    let n = Math.max(0, Math.round(raw));
    if (n < 1) return 0;
    if (n % 2) n += 1;
    return n;
  }

  function dominantVrb02(series) {
    const speeds = series.map(encodedEvenSpeedKt).filter(finite);
    if (speeds.length < 8) return null;
    const two = speeds.filter(v => v === 2).length;
    const share = two / speeds.length;
    const max = Math.max(...speeds);
    if (share < VRB02_SHARE || max > VRB02_OTHER_MAX_KT) return null;
    return {share, count:two, total:speeds.length, max};
  }

  function replaceBaseWind(line, token) {
    const re = /\b(?:VRB|\d{3})\d{2,3}(?:G(?:P99|\d{2,3}))?KT\b/;
    return re.test(line) ? line.replace(re, token) : line;
  }

  function suppressInsignificantLowWindChanges(lines, useVrb02) {
    if (!useVrb02) return lines;
    const out = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^BECMG\s+\d{4}\/\d{4}\s+((?:VRB|\d{3})\d{2,3}(?:G(?:P99|\d{2,3}))?KT)$/);
      if (m) {
        const w = parseWind(m[1]);
        // 5.a: zmiana VRB -> sektor jest istotna dopiero przy średniej prędkości >=10 KT.
        if (w && w.speed < 10) continue;
      }
      out.push(line);
    }
    return out;
  }

  function normalize(raw, series) {
    const lines = String(raw || '').split(/\n+/).map(x => x.trim().replace(/=$/, '')).filter(Boolean);
    if (!lines.length) return {text:raw, reps:[], vrb:null};

    const reps = baseCloudRepresentatives(series);
    lines[0] = normalizeCloudLine(lines[0], reps, true);
    for (let i = 1; i < lines.length; i++) lines[i] = normalizeCloudLine(lines[i], null, false);

    const vrb = dominantVrb02(series);
    if (vrb) lines[0] = replaceBaseWind(lines[0], 'VRB02KT');
    const filtered = suppressInsignificantLowWindChanges(lines, vrb);
    return {text:filtered.join('\n') + '=', reps, vrb};
  }

  function markResult(reps, vrb) {
    const sources = $('sources');
    if (sources) {
      let cloud = sources.querySelector('[data-taf-cloud-387]');
      if (!cloud) {
        cloud = document.createElement('span');
        cloud.className = 'pill ok';
        cloud.dataset.tafCloud387 = '1';
        sources.appendChild(cloud);
      }
      cloud.textContent = 'Chmury 3.8.7 ✓';

      let wind = sources.querySelector('[data-taf-vrb02]');
      if (!wind) {
        wind = document.createElement('span');
        wind.className = 'pill ' + (vrb ? 'ok' : '');
        wind.dataset.tafVrb02 = '1';
        sources.appendChild(wind);
      }
      wind.className = 'pill ' + (vrb ? 'ok' : '');
      wind.textContent = vrb ? 'VRB02 75% ✓' : 'VRB02 —';
    }

    const box = $('reasons');
    if (box) {
      box.querySelectorAll('[data-taf-policy-reason]').forEach(x => x.remove());
      let ul = box.querySelector('ul');
      if (!ul) { ul = document.createElement('ul'); box.appendChild(ul); }
      if (reps.length) {
        const li = document.createElement('li');
        li.dataset.tafPolicyReason = 'cloud';
        li.textContent = `Chmury: zastosowano 3.8.7 po sortowaniu wg podstawy — 1. warstwa dowolna, 2. >2/8, 3. >4/8; zwykłe chmury >=5000 ft pominięto. Baza: ${reps.map(r => `${r.token} (${r.avgOkta.toFixed(1)}/8, ${Math.round(r.presence*100)}%)`).join(', ')}.`;
        ul.appendChild(li);
      }
      if (vrb) {
        const li = document.createElement('li');
        li.dataset.tafPolicyReason = 'vrb';
        li.textContent = `VRB02KT: ${vrb.count}/${vrb.total} godzin (${Math.round(vrb.share*100)}%) daje po kodowaniu 02KT; pozostałe wartości nie przekraczają ${vrb.max}KT. Zmiany wyłącznie kierunku przy V<10KT nie tworzą BECMG.`;
        ul.appendChild(li);
      }
    }
  }

  function apply() {
    if (applying) return;
    const el = $('taf');
    const current = el?.textContent?.trim() || '';
    if (!/^TAF\s+(?:AMD\s+|COR\s+)?EPIR\b/.test(current) || current === lastOutput) return;
    const times = tafTimes(current);
    if (!times) return;
    const series = getSeries(times);
    if (!series.length) return;
    const r = normalize(current, series);
    markResult(r.reps, r.vrb);
    if (!r.text || r.text === current) { lastOutput = current; return; }
    applying = true;
    el.textContent = r.text;
    lastOutput = r.text;
    applying = false;
  }

  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; apply(); }, 40);
  }

  function install() {
    const el = $('taf');
    if (!el) return;
    new MutationObserver(schedule).observe(el, {childList:true, characterData:true, subtree:true});
    schedule();
  }

  window.PrognozaEPIRTAFGeneratorPolicy = Object.freeze({normalize, selectCloudTokens, dominantVrb02});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();
