'use strict';
(() => {
  if (!/\btaf\.html$/i.test(location.pathname)) return;

  const FT_PER_M = 3.28084;
  const SIG_CLOUD_FT = 1500;
  const ORDINARY_MIN_M = 450;
  const ORDINARY_MAX_M = 1500;
  const BASE_CLOUD_DOMINANCE = .50;
  const CONV_PROB_RAW = 50;
  const CONV_TEMPO_RAW = 75;
  const MAX_CHANGE_GROUPS = 5;
  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad = (v, n = 2) => String(Math.round(v)).padStart(n, '0');

  let lastOriginal = '';
  let lastEnhanced = '';
  let applying = false;
  let radarFrame = null;
  let radarPromise = null;
  let radarData = null;
  let consensusCache = [];

  function amountCode(okta) {
    const o = clamp(Math.round(okta), 0, 8);
    if (o <= 0) return null;
    if (o <= 2) return 'FEW';
    if (o <= 4) return 'SCT';
    if (o <= 7) return 'BKN';
    return 'OVC';
  }

  function parseCloudToken(token) {
    const m = String(token || '').match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/);
    if (!m) return null;
    return {amount: m[1], ft: Number(m[2]) * 100, type: m[3] || ''};
  }

  function monthTime(code, ref, minutes = false) {
    if (!/^\d{4,6}$/.test(code || '')) return NaN;
    const d = +code.slice(0, 2), h = +code.slice(2, 4), mi = minutes ? +code.slice(4, 6) : 0;
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
    return {issue: issueMs, start, end};
  }

  function ddhh(ms, end = false) {
    const d = new Date(ms);
    if (end && d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
      const q = new Date(ms - 1);
      return pad(q.getUTCDate()) + '24';
    }
    return pad(d.getUTCDate()) + pad(d.getUTCHours());
  }

  function cloudBandFt(ft) {
    const p = [200, 300, 500, 1000, 1500];
    if (!finite(ft)) return p.length;
    for (let i = 0; i < p.length; i++) if (ft < p[i]) return i;
    return p.length;
  }

  function rowCloudState(z) {
    const layers = [
      {o: Number(z?.oktaL), h: Number(z?.lowH)},
      {o: Number(z?.oktaM), h: Number(z?.midH)},
      {o: Number(z?.oktaH), h: Number(z?.highH)}
    ].filter(x => finite(x.o) && x.o > 0 && finite(x.h));
    const bkn = layers.filter(x => x.o >= 5).sort((a, b) => a.h - b.h)[0];
    const ceilFt = bkn ? bkn.h * FT_PER_M : (finite(z?.ceiling) ? Number(z.ceiling) * FT_PER_M : NaN);
    const lowCat = layers.some(x => x.o >= 5 && x.h * FT_PER_M < SIG_CLOUD_FT);
    return {layers, ceilFt, lowCat};
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

  function getConsensus(times) {
    const frame = $('engine');
    const w = frame?.contentWindow;
    if (!w) return [];
    try {
      const data = w.eval(`consensus.map(z=>({t:z.t,T:z.T,Td:z.Td,ceiling:z.ceiling,lowH:z.lowH,midH:z.midH,highH:z.highH,oktaL:z.oktaL,oktaM:z.oktaM,oktaH:z.oktaH,count:z.count,storm:z.storm,RR:z.RR}))`);
      if (!Array.isArray(data)) return [];
      consensusCache = data.filter(z => finite(z?.t) && z.t >= times.start && z.t < times.end);
      return consensusCache;
    } catch (_) {
      return [];
    }
  }

  function clusterOperationalClouds(series) {
    if (!series.length) return [];
    const stop = firstSignificantCloudChange(series);
    const scope = series.filter(z => z.t < stop);
    if (!scope.length) return [];

    // Dla zwykłych chmur stan bazowy ma reprezentować przeważającą część
    // okresu, a nie preferować pierwsze godziny. Ważymy jedynie jakością
    // konsensusu modeli; warstwa musi występować przez >50% ważonego okna.
    const hourWeights = scope.map(z => {
      const countFactor = finite(Number(z.count)) ? clamp(Number(z.count) / 8, .75, 1.25) : 1;
      return countFactor;
    });
    const totalW = hourWeights.reduce((a, b) => a + b, 0) || 1;
    const samples = [];
    scope.forEach((z, i) => {
      const candidates = [
        {o: Number(z.oktaL), h: Number(z.lowH)},
        {o: Number(z.oktaM), h: Number(z.midH)},
        {o: Number(z.oktaH), h: Number(z.highH)}
      ];
      for (const c of candidates) {
        if (!finite(c.o) || c.o <= 0 || !finite(c.h)) continue;
        if (c.h < ORDINARY_MIN_M || c.h >= ORDINARY_MAX_M) continue;
        samples.push({h: c.h, o: clamp(c.o, 0, 8), w: hourWeights[i], i});
      }
    });
    if (!samples.length) return [];

    samples.sort((a, b) => a.h - b.h);
    const clusters = [];
    for (const s of samples) {
      let best = null, bd = Infinity;
      for (const c of clusters) {
        const d = Math.abs(s.h - c.meanH);
        if (d < 350 && d < bd) { best = c; bd = d; }
      }
      if (!best) {
        best = {samples: [], meanH: s.h};
        clusters.push(best);
      }
      best.samples.push(s);
      const hw = best.samples.reduce((a, q) => a + q.w * Math.max(1, q.o), 0) || 1;
      best.meanH = best.samples.reduce((a, q) => a + q.h * q.w * Math.max(1, q.o), 0) / hw;
    }

    const reps = clusters.map(c => {
      const byHour = new Map();
      for (const s of c.samples) {
        const prev = byHour.get(s.i);
        if (!prev || s.o > prev.o) byHour.set(s.i, s);
      }
      let coverNum = 0, presentW = 0, heightNum = 0, heightDen = 0;
      scope.forEach((z, i) => {
        const s = byHour.get(i);
        const w = hourWeights[i];
        if (s) {
          coverNum += s.o * w;
          presentW += w;
          heightNum += s.h * w * Math.max(1, s.o);
          heightDen += w * Math.max(1, s.o);
        }
      });
      const avgOkta = coverNum / totalW;
      const presence = presentW / totalW;
      const hM = heightDen ? heightNum / heightDen : NaN;
      const code = amountCode(avgOkta);
      if (!code || presence <= BASE_CLOUD_DOMINANCE || !finite(hM)) return null;
      const ft100 = clamp(Math.round(hM * FT_PER_M / 100), 1, 999);
      return {code, avgOkta, presence, hM, token: code + pad(ft100, 3)};
    }).filter(Boolean).sort((a, b) => a.hM - b.hM);

    const out = [];
    if (reps[0]) out.push(reps[0]);
    for (let i = 1; i < reps.length && out.length < 3; i++) {
      const need = out.length === 1 ? 2 : 4;
      if (reps[i].avgOkta > need) out.push(reps[i]);
    }
    return out;
  }

  function replaceBaseClouds(raw, reps) {
    const lines = String(raw).split(/\n+/).map(x => x.trim()).filter(Boolean);
    if (!lines.length) return raw;
    const m = lines[0].match(/^(TAF(?:\s+(?:AMD|COR))?\s+EPIR\s+\d{6}Z\s+\d{4}\/\d{4}\s+)(.*)$/);
    if (!m) return raw;
    let state = m[2].trim();
    const allClouds = [...state.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)].map(x => ({raw: x[0], ft: +x[2] * 100, type: x[3] || '', amount: x[1]}));
    const significant = allClouds.filter(c => c.type || c.ft < SIG_CLOUD_FT);
    const significantOrdinary = significant.filter(c => !c.type);

    state = state.replace(/\b(?:FEW|SCT|BKN|OVC)\d{3}(?!CB\b|TCU\b)\b/g, tok => {
      const c = parseCloudToken(tok);
      return c && c.ft < SIG_CLOUD_FT ? tok : '';
    }).replace(/\bNSC\b/g, '').replace(/\s+/g, ' ').trim();

    const repTokens = reps.map(r => r.token);
    if (repTokens.length) {
      if (/\bCAVOK\b/.test(state)) state = state.replace(/\bCAVOK\b/, '9999');
      state = [state, ...repTokens].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    } else if (!significantOrdinary.length && !significant.some(c => c.type)) {
      const vis = state.match(/\b(\d{4})\b/);
      const hasWx = /\b(?:FG|BR|HZ|RA|DZ|SN|SHRA|SHSN|TS|TSRA|FZFG|FZRA|FZDZ|MIFG)\b/.test(state);
      if (!hasWx && (!vis || vis[1] === '9999')) {
        state = state.replace(/\b9999\b/g, '').replace(/\bCAVOK\b/g, '').replace(/\s+/g, ' ').trim() + ' CAVOK';
      } else if (!/\bCAVOK\b/.test(state)) {
        state = (state.replace(/\bNSC\b/g, '').replace(/\s+/g, ' ').trim() + ' NSC').trim();
      }
    }
    lines[0] = m[1] + state.replace(/\s+/g, ' ').trim();
    return lines.join('\n');
  }

  function ensureRadarFrame() {
    if (radarFrame?.isConnected) return radarFrame;
    radarFrame = document.createElement('iframe');
    radarFrame.id = 'tafRadarEngine';
    radarFrame.title = 'silnik TCU/CB Radar';
    radarFrame.src = 'radar.html?taf_engine=1';
    radarFrame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(radarFrame);
    return radarFrame;
  }

  function warsawLabel(ms) {
    return new Intl.DateTimeFormat('pl-PL', {timeZone:'Europe/Warsaw', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}).format(new Date(ms)).replace(/\s/g, '');
  }

  function parseRadarRows(doc) {
    const out = [];
    const trs = [...doc.querySelectorAll('#forecastRows tr')];
    for (const tr of trs) {
      const td = [...tr.children].map(x => x.textContent.trim());
      if (td.length < 7) continue;
      const target = td[0].replace(/\s/g, '');
      let best = NaN, bd = Infinity;
      const start = Date.now() - 2 * 3600e3;
      for (let k = 0; k <= 18; k++) {
        const ms = Math.round((start + k * 3600e3) / 3600e3) * 3600e3;
        if (warsawLabel(ms) !== target) continue;
        const d = Math.abs(ms - Date.now());
        if (d < bd) { bd = d; best = ms; }
      }
      if (!finite(best)) continue;
      const num = s => { const m = String(s).replace(',', '.').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; };
      out.push({t:best,temp:num(td[1]),rain:num(td[2]),cape:num(td[3]),tp:num(td[4]),gust:num(td[5]),aifs:td[6]});
    }
    return out;
  }

  async function loadRadarData() {
    if (radarPromise) return radarPromise;
    radarPromise = (async () => {
      const f = ensureRadarFrame();
      const deadline = Date.now() + 18000;
      while (Date.now() < deadline) {
        try {
          const w = f.contentWindow, d = f.contentDocument;
          const rows = d ? parseRadarRows(d) : [];
          const live = d?.getElementById('liveBadge')?.textContent === 'LIVE';
          const rn = w?.PrognozaEPIRRadarNowcast || null;
          if (live && rows.length >= 3) {
            const n = s => { const m = String(s || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; };
            radarData = {
              rows,
              currentStorm: n(d.getElementById('stormRisk')?.textContent),
              currentDbz: n(d.getElementById('dbz')?.textContent),
              nowcast: rn
            };
            if (!rn && Date.now() + 3500 < deadline) { await new Promise(r => setTimeout(r, 450)); continue; }
            return radarData;
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 350));
      }
      return radarData;
    })();
    return radarPromise;
  }

  function nearestRadarModel(t, data) {
    if (!data?.rows?.length) return null;
    let best = null, bd = Infinity;
    for (const r of data.rows) {
      const d = Math.abs(r.t - t);
      if (d < bd) { bd = d; best = r; }
    }
    return bd <= 70 * 60000 ? best : null;
  }

  function radarContribution(t, data) {
    const rn = data?.nowcast;
    if (!rn || rn.error || !rn.predictions) return {score:0, echo:NaN, support:NaN};
    const hMin = (t - Date.now()) / 60000;
    if (hMin < -30 || hMin > 210) return {score:0, echo:NaN, support:NaN};
    const keys = Object.keys(rn.predictions).map(Number).filter(finite);
    if (!keys.length) return {score:0, echo:NaN, support:NaN};
    const target = clamp(hMin, Math.min(...keys), Math.max(...keys));
    const k = keys.sort((a,b) => Math.abs(a-target)-Math.abs(b-target))[0];
    const echo = Number(rn.predictions[k]);
    const conf = clamp(Number(rn.confidence) || 0, 0, 100) / 100;
    let raw = 0;
    if (rn.source === 'cmax' && finite(echo)) raw = echo >= 50 ? 45 : echo >= 45 ? 30 : echo >= 35 ? 14 : echo >= 27 ? 6 : 0;
    else if (rn.source === 'sri' && finite(echo)) raw = echo >= 10 ? 35 : echo >= 3 ? 22 : echo >= 1 ? 12 : echo >= .1 ? 5 : 0;
    const support = rn.models?.total ? rn.models.support / rn.models.total : NaN;
    return {score: raw * (.55 + .45 * conf), echo, support};
  }

  function convectiveSeries(times, series, data) {
    if (!data) return [];
    const events = [];
    for (const z of series) {
      const r = nearestRadarModel(z.t, data);
      if (!r) continue;
      const rc = radarContribution(z.t, data);
      const tp = clamp(Number(r.tp) || 0, 0, 100);
      const cape = Math.max(0, Number(r.cape) || 0);
      const current = finite(data.currentStorm) ? data.currentStorm * Math.exp(-Math.max(0, (z.t - Date.now()) / 3600e3) / 2.5) : 0;
      const capePart = clamp(cape / 40, 0, 35);
      const showerPart = /przelot|burza/i.test(r.aifs || '') ? 6 : (Number(r.rain) >= .3 ? 3 : 0);
      const index = Math.round(clamp(tp * .62 + capePart + rc.score + current * .10 + showerPart, 0, 99));
      if (index < CONV_PROB_RAW) continue;

      const tafProb = clamp(index * .8 - 10, 0, 70);
      const kind = index >= CONV_TEMPO_RAW ? 'TEMPO' : 'PROB30 TEMPO';
      const isCb = tp >= 50 || index >= 75 || (data.nowcast?.source === 'cmax' && finite(rc.echo) && rc.echo >= 45);
      const type = isCb ? 'CB' : 'TCU';
      const support = finite(rc.support) ? rc.support : 0;
      const cover = (support >= .67 && index >= 65) || index >= 88 ? 'SCT' : 'FEW';
      let baseM = Number(z.lowH);
      if (!finite(baseM) || baseM < 250 || baseM > 2500) {
        const dep = Number(z.T) - Number(z.Td);
        baseM = finite(dep) ? clamp(125 * Math.max(0, dep), 300, 2500) : 900;
      }
      const baseFt100 = clamp(Math.round(baseM * FT_PER_M / 100), 1, 999);
      let wx = '';
      if (type === 'CB' && tp >= 50 && Number(r.rain) >= .3) wx = 'TSRA';
      else if (Number(r.rain) >= .3 && /przelot/i.test(r.aifs || '')) wx = 'SHRA';
      events.push({t:z.t,index,tafProb,kind,type,cover,baseM,cloud:`${cover}${pad(baseFt100,3)}${type}`,wx,tp,rain:Number(r.rain)||0,support});
    }
    return events;
  }

  function mergeConvective(events, endMs) {
    const out = [];
    for (const e of events.sort((a,b) => a.t-b.t)) {
      const last = out.at(-1);
      if (last && last.kind === e.kind && last.type === e.type && e.t - last.lastT <= 90 * 60000 && e.t - last.s < 4 * 3600e3) {
        last.lastT = e.t;
        last.e = Math.min(endMs, e.t + 3600e3);
        if (e.index > last.index) Object.assign(last, {...e, s:last.s, e:last.e, lastT:e.t});
      } else {
        out.push({...e, s:e.t, e:Math.min(endMs, e.t + 3600e3), lastT:e.t});
      }
    }
    return out;
  }

  function overlap(a0, a1, b0, b1) { return a0 < b1 && b0 < a1; }

  function parseGroupPeriod(line, ref) {
    const m = String(line).match(/\b(\d{4})\/(\d{4})\b/);
    if (!m) return null;
    const s = monthTime(m[1], ref), e = monthTime(m[2], s + 2 * 3600e3);
    return {s, e:e <= s ? monthTime(m[2], s + 12 * 3600e3) : e};
  }

  function addConvectiveGroups(raw, groups, times) {
    if (!groups.length) return raw;
    let lines = String(raw).split(/\n+/).map(x => x.trim()).filter(Boolean);
    const radarHorizon = Date.now() + 7 * 3600e3;
    lines = lines.filter((line, i) => {
      if (i === 0 || !/\b(?:CB|TCU)\b/.test(line)) return true;
      const p = parseGroupPeriod(line, times.issue);
      return !p || p.s >= radarHorizon;
    });
    let changeCount = Math.max(0, lines.length - 1);
    for (const g of groups) {
      if (changeCount >= MAX_CHANGE_GROUPS) break;
      const gp = `${g.kind} ${ddhh(g.s)}/${ddhh(g.e, true)} ${[g.wx, g.cloud].filter(Boolean).join(' ')}`;
      const conflict = lines.slice(1).some(line => {
        if (!/\b(?:CB|TCU)\b/.test(line)) return false;
        const p = parseGroupPeriod(line, times.issue);
        return p && overlap(p.s,p.e,g.s,g.e);
      });
      if (!conflict) { lines.push(gp); changeCount++; }
    }
    const base = lines.shift();
    lines.sort((a,b) => {
      const pa=parseGroupPeriod(a,times.issue), pb=parseGroupPeriod(b,times.issue);
      return (pa?.s||Infinity)-(pb?.s||Infinity);
    });
    return [base, ...lines].join('\n');
  }

  function enhanceReasons(reps, conv) {
    const box = $('reasons');
    if (!box) return;
    const extra = [];
    if (reps.length) {
      extra.push(`Chmury zwykłe 450–1500 m: warstwa bazowa musi dominować przez >50% ważonego okresu; następnie użyto średniej ważonej liczby modeli, wielkości i wysokości warstwy: ${reps.map(r => `${r.token} (śr. ${r.avgOkta.toFixed(1)}/8, obecność ${Math.round(r.presence*100)}%)`).join(', ')}. Sama zmiana wysokości w tym zakresie nie tworzy grupy zmian TAF.`);
    }
    for (const g of conv) {
      extra.push(`${g.kind} ${ddhh(g.s)}/${ddhh(g.e,true)} ${g.cloud}: silnik Radar TCU/CB indeks ${g.index}/100 → skalibrowane P(TAF) ~${Math.round(g.tafProb)}%; typ ${g.type}${finite(g.support)?`, wsparcie modeli ${Math.round(g.support*100)}%`:''}.`);
    }
    if (!extra.length) return;
    const ul = box.querySelector('ul');
    if (ul) extra.forEach(x => { const li=document.createElement('li'); li.textContent=x; ul.appendChild(li); });
    else box.innerHTML = '<ul>' + extra.map(x => `<li>${x.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</li>`).join('') + '</ul>';
  }

  function markSource(radarOk) {
    const s = $('sources');
    if (s && !s.querySelector('[data-taf-conv]')) {
      const p = document.createElement('span');
      p.className = 'pill ' + (radarOk ? 'ok' : 'warn');
      p.dataset.tafConv = '1';
      p.textContent = radarOk ? 'TCU/CB Radar ✓' : 'TCU/CB model fallback';
      s.appendChild(p);
    }
    const conf = $('conf');
    if (conf && !/Chmury zwykłe:/.test(conf.textContent)) conf.textContent += ' Chmury zwykłe: stan dominujący >50% ważonego okresu w zakresie 450–1500 m; TCU/CB: wspólny silnik Radary + modele.';
  }

  async function processOriginal(original) {
    const times = tafTimes(original);
    if (!times) return;
    const series = getConsensus(times);
    if (!series.length) return;
    const reps = clusterOperationalClouds(series);
    let enhanced = replaceBaseClouds(original, reps);
    applying = true;
    $('taf').textContent = enhanced;
    lastEnhanced = enhanced;
    applying = false;
    enhanceReasons(reps, []);
    markSource(false);

    const rd = await loadRadarData().catch(() => null);
    if (original !== lastOriginal) return;
    const conv = mergeConvective(convectiveSeries(times, series, rd), times.end);
    enhanced = addConvectiveGroups(replaceBaseClouds(original, reps), conv, times);
    applying = true;
    $('taf').textContent = enhanced;
    lastEnhanced = enhanced;
    applying = false;
    enhanceReasons(reps, conv);
    markSource(!!rd?.nowcast);
  }

  function onTafChanged() {
    if (applying) return;
    const el = $('taf');
    const current = el?.textContent?.trim() || '';
    if (!/^TAF\s+EPIR\b/.test(current) || current === lastEnhanced || current === lastOriginal) return;
    lastOriginal = current;
    radarPromise = null; radarData = null;
    processOriginal(current).catch(e => console.warn('TAF cloud policy:', e));
  }

  function install() {
    const tafEl = $('taf');
    if (!tafEl) return;
    new MutationObserver(onTafChanged).observe(tafEl, {childList:true, characterData:true,subtree:true});
    const copy = $('copy');
    copy?.addEventListener('click', async e => {
      if (!lastEnhanced) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      try { await navigator.clipboard.writeText($('taf')?.textContent || lastEnhanced); } catch (_) {}
      copy.textContent = 'Skopiowano';
      setTimeout(() => copy.textContent = 'Kopiuj TAF', 1200);
    }, true);
    onTafChanged();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();
