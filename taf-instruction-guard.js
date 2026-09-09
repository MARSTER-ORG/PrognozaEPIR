'use strict';
(() => {
  const HOUR = 3600e3;
  const KT_PER_MS = 1.94384;
  const FT_PER_M = 3.28084;
  const CAVOK_BASE_LIMIT_M = 1500;
  const CAVOK_BASE_LIMIT_FT = CAVOK_BASE_LIMIT_M * FT_PER_M;
  // EPIR: local operational cloud threshold is 1500 m = 4921.26 ft for both CAVOK and NSC.
  const NSC_LIMIT_FT = CAVOK_BASE_LIMIT_FT;
  const CEILING_THRESHOLDS_FT = [200, 300, 500, 1000, 1500];
  const VIS_THRESHOLDS_M = [800, 1500, 3000, 5000];
  const GUST_GAP_KT = 10;
  const GUST_CHANGE_MEAN_MIN_KT = 15;
  const PERSISTENT_GUST_HOURS = 4;
  const MAX_CHANGE_GROUPS = 5;
  const WX_FORBIDDEN_FOG = new Set(['MIFG', 'BCFG', 'PRFG']);
  const WX_VIS_LIMITED = new Set(['BR', 'SA', 'DU', 'HZ', 'FU']);
  const WX_FOG = new Set(['FG', 'FZFG']);
  const WX_CODES = new Set([
    'DZ','RA','SN','SG','PL','DS','SS','FZDZ','FZRA','SHGR','SHGS','SHRA','SHSN',
    'TSGR','TSGS','TSRA','TSSN','FG','BR','SA','DU','HZ','FU','VA','SQ','PO','FC','TS',
    'BLDU','BLSA','BLSN','DRDU','DRSA','DRSN','FZFG'
  ]);
  const finite = Number.isFinite;
  const pad = (v, n = 2) => String(Math.round(v)).padStart(n, '0');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function circular(a, b) {
    if (!finite(a) || !finite(b)) return 180;
    let x = Math.abs(a - b) % 360;
    return x > 180 ? 360 - x : x;
  }
  function band(value, thresholds) {
    if (!finite(value)) return thresholds.length;
    for (let i = 0; i < thresholds.length; i++) if (value < thresholds[i]) return i;
    return thresholds.length;
  }
  function visibilityBand(v) { return band(v, VIS_THRESHOLDS_M); }
  function ceilingBandFt(ft) { return band(ft, CEILING_THRESHOLDS_FT); }
  function normalizeVisibilityValue(value) {
    const v = Number(value);
    if (!finite(v) || v >= 10000) return 9999;
    if (v < 800) return clamp(Math.round(v / 50) * 50, 0, 750);
    if (v < 5000) return clamp(Math.round(v / 100) * 100, 800, 4900);
    return clamp(Math.round(v / 1000) * 1000, 5000, 9000);
  }
  function normalizeVisibilityCode(code) {
    if (String(code) === '9999') return '9999';
    if (!/^\d{4}$/.test(String(code || ''))) return code;
    return pad(normalizeVisibilityValue(Number(code)), 4);
  }
  function monthTime(code, ref, minutes = false) {
    if (!/^\d{4,6}$/.test(String(code || ''))) return NaN;
    const d = +String(code).slice(0, 2);
    const h = +String(code).slice(2, 4);
    const mi = minutes ? +String(code).slice(4, 6) : 0;
    const R = new Date(ref);
    const candidates = [];
    for (let dm = -1; dm <= 1; dm++) {
      candidates.push(Date.UTC(R.getUTCFullYear(), R.getUTCMonth() + dm, d, h, mi));
    }
    return candidates.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref))[0];
  }
  function tafTimes(raw, now = Date.now()) {
    const issue = String(raw).match(/\b(\d{6})Z\b/);
    const validity = String(raw).match(/\b(\d{4})\/(\d{4})\b/);
    if (!issue || !validity) return null;
    const issueMs = monthTime(issue[1], now, true);
    const start = monthTime(validity[1], issueMs);
    let end = monthTime(validity[2], start + 6 * HOUR);
    if (end <= start) end = monthTime(validity[2], start + 18 * HOUR);
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
  function parsePeriodCodes(a, b, ref) {
    const s = monthTime(a, ref);
    let e = monthTime(b, s + 2 * HOUR);
    if (e <= s) e = monthTime(b, s + 12 * HOUR);
    return {s, e};
  }
  function parseWindToken(token) {
    const m = String(token || '').match(/^(VRB|\d{3})(P99|\d{2,3})(?:G(P99|\d{2,3}))?KT$/);
    if (!m) return null;
    const speed = m[2] === 'P99' ? 100 : Number(m[2]);
    const gust = m[3] ? (m[3] === 'P99' ? 100 : Number(m[3])) : null;
    return {
      raw: m[0],
      dirCode: m[1],
      dir: m[1] === 'VRB' ? null : Number(m[1]),
      vrb: m[1] === 'VRB',
      speed,
      speedP99: m[2] === 'P99',
      gust,
      gustP99: m[3] === 'P99'
    };
  }
  function windSpeedCode(speed) {
    if (speed >= 100) return 'P99';
    return pad(clamp(Math.round(speed), 0, 99), 2);
  }
  function gustCode(gust) {
    if (gust >= 100) return 'P99';
    return pad(clamp(Math.round(gust), 0, 99), 2);
  }
  function formatWind(w, includeGust = true) {
    if (!w) return '';
    if (w.speed < 1) return '00000KT';
    const dir = w.vrb ? 'VRB' : pad((Math.round((w.dir || 360) / 10) * 10) % 360 || 360, 3);
    let out = dir + windSpeedCode(w.speed);
    if (includeGust && finite(w.gust) && w.gust - w.speed >= GUST_GAP_KT) out += 'G' + gustCode(w.gust);
    return out + 'KT';
  }
  function stripGustFromWind(token) {
    const w = parseWindToken(token);
    return w ? formatWind({...w, gust: null}, false) : token;
  }
  function parseCloudToken(token) {
    const m = String(token || '').match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/);
    if (!m) return null;
    return {raw:m[0], amount:m[1], ft:Number(m[2]) * 100, type:m[3] || ''};
  }
  function amountMinOkta(amount) {
    return amount === 'FEW' ? 1 : amount === 'SCT' ? 3 : amount === 'BKN' ? 5 : amount === 'OVC' ? 8 : 0;
  }
  function bareWx(token) { return String(token || '').replace(/^[-+]/, ''); }
  function isWeatherToken(token) {
    const raw = String(token || '');
    const t = bareWx(raw);
    if (!t || t === 'NSW') return false;
    if (WX_FORBIDDEN_FOG.has(t)) return true;
    if (WX_CODES.has(t)) return true;
    if (/^(?:FZ)?(?:DZ|RA|SN|SG|PL|GR|GS){1,3}$/.test(t)) return true;
    if (/^(?:SH|TS)(?:DZ|RA|SN|SG|PL|GR|GS){1,3}$/.test(t)) return true;
    return false;
  }
  function isWeakPrecip(token) {
    const t = String(token || '');
    return /^-(?:DZ|RA|SN|SG|PL|SHRA|SHSN)$/.test(t);
  }
  function weatherAllowedAtVisibility(token, vis) {
    const t = bareWx(token);
    if (WX_FORBIDDEN_FOG.has(t)) return false;
    if (WX_FOG.has(t)) return !finite(vis) || vis <= 900;
    if (WX_VIS_LIMITED.has(t)) return !finite(vis) || vis <= 5000;
    return true;
  }
  function tokenKind(token) {
    if (parseWindToken(token)) return 'wind';
    if (/^(?:9999|\d{4})$/.test(token)) return 'vis';
    if (token === 'CAVOK') return 'cavok';
    if (token === 'NSW') return 'nsw';
    if (token === 'NSC') return 'nsc';
    if (/^VV(?:\d{3}|\/\/\/)$/.test(token)) return 'vv';
    if (parseCloudToken(token)) return 'cloud';
    if (isWeatherToken(token)) return 'wx';
    return 'other';
  }
  function parseLine(line, index, ref) {
    const clean = String(line || '').replace(/=$/, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const base = clean.match(/^(TAF(?:\s+(?:AMD|COR))?\s+EPIR\s+\d{6}Z\s+\d{4}\/\d{4}\s+)(.*)$/);
    if (base) return {kind:'BASE', prefix:base[1], payload:base[2], index};
    const fm = clean.match(/^(FM(\d{6}))(?:\s+(.*))?$/);
    if (fm) return {kind:'FM', prefix:fm[1] + ' ', payload:fm[3] || '', index, s:monthTime(fm[2], ref, true)};
    const g = clean.match(/^((PROB(?:30|40)\s+TEMPO|PROB(?:30|40)|BECMG|TEMPO)\s+(\d{4})\/(\d{4}))(?:\s+(.*))?$/);
    if (g) {
      const p = parsePeriodCodes(g[3], g[4], ref);
      return {kind:g[2], prefix:g[1] + ' ', payload:g[5] || '', index, s:p.s, e:p.e};
    }
    return {kind:'OTHER', prefix:'', payload:clean, index};
  }
  function cloneState(s) {
    return {wind:s?.wind || '', vis:s?.vis ?? null, wx:[...(s?.wx || [])], clouds:[...(s?.clouds || [])], cavok:!!s?.cavok, nsc:!!s?.nsc};
  }
  function stateFromTokens(tokens, previous = null, full = false) {
    const s = full ? {wind:'',vis:null,wx:[],clouds:[],cavok:false,nsc:false} : cloneState(previous || {});
    const wind = tokens.find(t => tokenKind(t) === 'wind');
    const vis = tokens.find(t => tokenKind(t) === 'vis');
    const wx = tokens.filter(t => tokenKind(t) === 'wx');
    const clouds = tokens.filter(t => tokenKind(t) === 'cloud');
    if (tokens.includes('CAVOK')) return {wind:wind || s.wind, vis:10000, wx:[], clouds:[], cavok:true, nsc:false};
    if (wind) s.wind = wind;
    if (vis) s.vis = vis === '9999' ? 10000 : Number(vis);
    if (tokens.includes('NSW')) s.wx = [];
    else if (wx.length) s.wx = wx;
    if (tokens.includes('NSC')) { s.clouds = []; s.nsc = true; }
    else if (clouds.length) { s.clouds = clouds; s.nsc = false; }
    s.cavok = false;
    return s;
  }
  function selectCloudLayers(tokens, ordinaryLimitFt = NSC_LIMIT_FT) {
    const parsed = tokens.map(parseCloudToken).filter(Boolean).filter(c => c.type || c.ft < ordinaryLimitFt);
    if (!parsed.length) return [];
    const byBase = new Map();
    for (const c of parsed) {
      const key = c.ft;
      const list = byBase.get(key) || [];
      list.push(c);
      byBase.set(key, list);
    }
    const folded = [];
    for (const list of byBase.values()) {
      const cb = list.find(x => x.type === 'CB');
      const tcu = list.find(x => x.type === 'TCU');
      if (cb && tcu) {
        const amount = [cb.amount, tcu.amount].sort((a,b) => amountMinOkta(b)-amountMinOkta(a))[0];
        folded.push({...cb, amount, raw:amount + pad(cb.ft / 100, 3) + 'CB'});
        list.filter(x => x !== cb && x !== tcu).forEach(x => folded.push(x));
      } else folded.push(...list);
    }
    folded.sort((a,b) => a.ft - b.ft || (a.type ? 1 : -1));
    const ordinary = folded.filter(c => !c.type);
    const conv = folded.filter(c => c.type);
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
  function weatherRank(token) {
    const t = bareWx(token);
    if (/^(?:FZ)?(?:DZ|RA|SN|SG|PL|GR|GS){1,3}$/.test(t) || /^(?:SH|TS)(?:DZ|RA|SN|SG|PL|GR|GS){1,3}$/.test(t)) return 0;
    if (WX_VIS_LIMITED.has(t) || /^(?:BLDU|BLSA|BLSN|DRDU|DRSA|DRSN)$/.test(t)) return 1;
    return 2;
  }
  function compressCavok(tokens, ctx, requireMetChange = false) {
    const hasMetChange = tokens.some(t => ['vis','wx','cloud','nsw','nsc','cavok'].includes(tokenKind(t)));
    if (requireMetChange && !hasMetChange) return tokens;
    const wind = tokens.find(t => tokenKind(t) === 'wind');
    const visCode = tokens.find(t => tokenKind(t) === 'vis');
    const vis = visCode ? (visCode === '9999' ? 10000 : Number(visCode)) : ctx.previous?.vis;
    const explicitWx = tokens.filter(t => tokenKind(t) === 'wx');
    const wx = tokens.includes('NSW') ? [] : explicitWx.length ? explicitWx : (ctx.kind === 'BASE' ? [] : (ctx.previous?.wx || []));
    const explicitClouds = tokens.filter(t => tokenKind(t) === 'cloud');
    const clouds = tokens.includes('NSC') ? [] : explicitClouds.length ? explicitClouds : (ctx.kind === 'BASE' ? [] : (ctx.previous?.clouds || []));
    const limitFt = ctx.cavokLimitFt || CAVOK_BASE_LIMIT_FT;
    const blocks = clouds.some(t => { const c=parseCloudToken(t); return c && (c.type || c.ft < limitFt); });
    if (finite(vis) && vis >= 10000 && wx.length === 0 && !blocks) return [wind, 'CAVOK'].filter(Boolean);
    return tokens;
  }
  function reorderTokens(tokens) {
    const wind = tokens.filter(t => tokenKind(t) === 'wind');
    const cavok = tokens.includes('CAVOK');
    if (cavok) return [...wind.slice(0,1), 'CAVOK'];
    const vis = tokens.filter(t => tokenKind(t) === 'vis');
    const wx = tokens.filter(t => tokenKind(t) === 'wx')
      .map((t,i)=>({t,i,r:weatherRank(t)}))
      .sort((a,b)=>a.r-b.r||a.i-b.i)
      .slice(0,3).map(x=>x.t);
    const nsw = tokens.includes('NSW') ? ['NSW'] : [];
    const clouds = tokens.filter(t => tokenKind(t) === 'cloud');
    const nsc = tokens.includes('NSC') && !clouds.length ? ['NSC'] : [];
    const other = tokens.filter(t => tokenKind(t) === 'other');
    return [...wind.slice(0,1), ...vis.slice(0,1), ...wx, ...nsw, ...clouds, ...nsc, ...other]
      .filter((t, i, a) => t && a.indexOf(t) === i);
  }
  function normalizePayload(payload, ctx) {
    const original = String(payload || '').replace(/=$/, '').trim().split(/\s+/).filter(Boolean);
    let tokens = original.filter(t => tokenKind(t) !== 'vv');
    tokens = tokens.filter(t => !WX_FORBIDDEN_FOG.has(bareWx(t)));
    tokens = tokens.map(t => tokenKind(t) === 'vis' ? normalizeVisibilityCode(t) : t);
    tokens = tokens.map(t => {
      const w = parseWindToken(t);
      if (!w) return t;
      if (w.speed < 1) return '00000KT';
      if (finite(w.gust) && w.gust - w.speed < GUST_GAP_KT) return formatWind({...w, gust:null}, false);
      return formatWind(w, true);
    });
    const explicitVisCode = tokens.find(t => tokenKind(t) === 'vis');
    const effectiveVis = explicitVisCode ? (explicitVisCode === '9999' ? 10000 : Number(explicitVisCode)) : ctx.previous?.vis;
    tokens = tokens.filter(t => tokenKind(t) !== 'wx' || weatherAllowedAtVisibility(t, effectiveVis));
    const cloudTokens = selectCloudLayers(tokens.filter(t => tokenKind(t) === 'cloud'), ctx.nscLimitFt || NSC_LIMIT_FT);
    tokens = tokens.filter(t => tokenKind(t) !== 'cloud').concat(cloudTokens);
    const hadCavok = tokens.includes('CAVOK');
    const hasWx = tokens.some(t => tokenKind(t) === 'wx');
    const hasSigCloud = tokens.some(t => {
      const c = parseCloudToken(t);
      return c && (c.type || c.ft < (ctx.cavokLimitFt || CAVOK_BASE_LIMIT_FT));
    });
    if (hadCavok && (hasWx || hasSigCloud)) {
      tokens = tokens.filter(t => t !== 'CAVOK');
      if (!tokens.some(t => tokenKind(t) === 'vis')) tokens.push('9999');
    }
    if (ctx.kind !== 'BASE' && tokens.some(t => parseCloudToken(t)?.type) && !tokens.some(t => {
      const c = parseCloudToken(t); return c && !c.type;
    }) && ctx.previous?.clouds?.length) {
      const prevOrdinary = ctx.previous.clouds.filter(t => {
        const c = parseCloudToken(t); return c && !c.type && c.ft < (ctx.nscLimitFt || NSC_LIMIT_FT);
      });
      tokens.push(...prevOrdinary);
      const allClouds = selectCloudLayers(tokens.filter(t => tokenKind(t) === 'cloud'), ctx.nscLimitFt || NSC_LIMIT_FT);
      tokens = tokens.filter(t => tokenKind(t) !== 'cloud').concat(allClouds);
    }
    const hasExplicitWx = tokens.some(t => tokenKind(t) === 'wx') || tokens.includes('NSW') || tokens.includes('CAVOK');
    const repeatsPrevailingWx = ['BECMG','TEMPO','PROB30','PROB30 TEMPO'].includes(ctx.kind);
    if (repeatsPrevailingWx && !hasExplicitWx && ctx.previous?.wx?.length) {
      const continued = ctx.previous.wx.filter(t => weatherAllowedAtVisibility(t, effectiveVis));
      tokens.push(...continued);
    }
    if (tokens.includes('NSW') && ctx.previous?.wx?.length && ctx.previous.wx.every(isWeakPrecip)) {
      tokens = tokens.filter(t => t !== 'NSW');
    }
    if (ctx.kind === 'BASE' || (tokens.includes('NSW') && !(ctx.previous?.wx?.length))) tokens = tokens.filter(t => t !== 'NSW');
    if (tokens.includes('CAVOK')) {
      tokens = tokens.filter(t => tokenKind(t) === 'wind' || t === 'CAVOK');
    } else {
      const cloudsNow = tokens.filter(t => tokenKind(t) === 'cloud');
      if (cloudsNow.length) tokens = tokens.filter(t => t !== 'NSC');
      if (!cloudsNow.length && (ctx.kind === 'BASE' || tokens.includes('NSC'))) {
        if (!tokens.includes('NSC')) tokens.push('NSC');
      }
      tokens = compressCavok(tokens, ctx, ctx.kind !== 'BASE');
    }
    return reorderTokens(tokens);
  }
  function groupKey(g) {
    if (g.kind === 'FM') return g.prefix.trim();
    return `${g.kind}|${finite(g.s) ? g.s : ''}|${finite(g.e) ? g.e : ''}`;
  }
  function mergeSameGroups(groups) {
    const out = [];
    const seen = new Map();
    for (const g of groups) {
      if (g.kind === 'BASE' || g.kind === 'OTHER' || g.kind === 'FM') { out.push(g); continue; }
      const k = groupKey(g);
      const hit = seen.get(k);
      if (!hit) { seen.set(k, g); out.push(g); continue; }
      const merged = reorderTokens([...hit.tokens, ...g.tokens]);
      hit.tokens = merged;
    }
    return out;
  }
  function groupPriority(g) {
    const text = (g.tokens || []).join(' ');
    if (g.kind === 'FM') return 100;
    if (g.kind === 'BECMG') return 90;
    if (/\b(?:FZFG|FZRA|FZDZ|TS|TSRA|TSGR|TSSN|SQ|FC)\b/.test(text)) return 85;
    if (/\b(?:FG|\+?RA|\+?SN|SHRA|SHSN)\b/.test(text)) return 75;
    if ((g.tokens || []).some(t => parseCloudToken(t)?.type)) return 70;
    if (g.kind === 'TEMPO') return 60;
    if (g.kind.startsWith('PROB30')) return 40;
    return 50;
  }
  function sortChangeGroups(groups) {
    const base = groups.find(g => g.kind === 'BASE');
    const order = {'FM':0,'BECMG':1,'TEMPO':2,'PROB30 TEMPO':3,'PROB30':4};
    const changes = groups.filter(g => g.kind !== 'BASE' && g.kind !== 'OTHER')
      .map((g,i) => ({g,i}))
      .sort((a,b) => (a.g.s ?? Infinity)-(b.g.s ?? Infinity) || (order[a.g.kind] ?? 9)-(order[b.g.kind] ?? 9) || a.i-b.i)
      .map(x => x.g);
    return [base, ...changes].filter(Boolean);
  }
  function limitGroups(groups, issues) {
    const base = groups.find(g => g.kind === 'BASE');
    let changes = groups.filter(g => g.kind !== 'BASE' && g.kind !== 'OTHER');
    if (changes.length <= MAX_CHANGE_GROUPS) return sortChangeGroups([base, ...changes].filter(Boolean));
    issues.push({level:'warn', code:'GROUP_LIMIT', text:`Scalono/ograniczono grupy zmian z ${changes.length} do ${MAX_CHANGE_GROUPS}.`});
    changes = changes
      .map((g,i) => ({g,i,p:groupPriority(g)}))
      .sort((a,b) => b.p-a.p || a.i-b.i)
      .slice(0, MAX_CHANGE_GROUPS)
      .map(x => x.g);
    return sortChangeGroups([base, ...changes].filter(Boolean));
  }
  function nearestSeries(series, t) {
    if (!Array.isArray(series) || !series.length || !finite(t)) return null;
    let best = null, bd = Infinity;
    for (const z of series) {
      if (!finite(z?.t)) continue;
      const d = Math.abs(z.t - t);
      if (d < bd) { bd = d; best = z; }
    }
    return bd <= 90 * 60000 ? best : null;
  }
  function vectorRepresentative(events, includeGust) {
    if (!events.length) return null;
    let u=0, v=0, sw=0, ss=0, count=0;
    const gusts=[];
    for (const e of events) {
      const speed = e.speedKt;
      const w = finite(e.weight) ? e.weight : 1;
      ss += speed*w; count += w;
      if (finite(e.dir)) {
        const r=e.dir*Math.PI/180;
        u += -Math.sin(r)*speed*w;
        v += -Math.cos(r)*speed*w;
        sw += speed*w;
      }
      if (finite(e.gustKt)) gusts.push(e.gustKt);
    }
    const speed = count ? ss/count : events[0].speedKt;
    let dir=null, vrb=true;
    if (sw>0) {
      dir=(Math.atan2(-u,-v)*180/Math.PI+360)%360;
      const resultant=Math.hypot(u,v)/sw;
      vrb = resultant < .35;
    }
    let gust=null;
    if (includeGust && gusts.length) {
      const a=gusts.slice().sort((x,y)=>x-y);
      const q=a[Math.min(a.length-1,Math.floor((a.length-1)*.75))];
      gust=Math.max(speed+GUST_GAP_KT,q);
    }
    return {speed,dir,vrb,gust};
  }
  function classifyGustEpisodes(series, times) {
    if (!Array.isArray(series) || !times) return [];
    const events=[];
    for (const z of series) {
      if (!finite(z?.t) || z.t < times.start || z.t >= times.end) continue;
      const ws=Number(z.WS), g=Number(z.G), wd=Number(z.WD);
      if (!finite(ws) || !finite(g)) continue;
      const speedKt=ws*KT_PER_MS, gustKt=g*KT_PER_MS;
      if (gustKt-speedKt < GUST_GAP_KT) continue;
      const count=Number(z.count);
      events.push({t:z.t,speedKt,gustKt,dir:finite(wd)?wd:null,weight:finite(count)?clamp(count/8,.75,1.25):1});
    }
    const groups=[];
    for (const e of events.sort((a,b)=>a.t-b.t)) {
      const last=groups.at(-1);
      if (last && e.t-last.lastT<=90*60000) {
        last.events.push(e); last.lastT=e.t; last.e=Math.min(times.end,e.t+HOUR);
      } else groups.push({s:e.t,e:Math.min(times.end,e.t+HOUR),lastT:e.t,events:[e]});
    }
    for (const g of groups) {
      const durationH=(g.e-g.s)/HOUR;
      const persistent=durationH>=PERSISTENT_GUST_HOURS && g.events.every(e=>e.speedKt>=GUST_CHANGE_MEAN_MIN_KT);
      g.durationH=durationH;
      g.persistent=persistent;
      g.rep=vectorRepresentative(g.events,true);
    }
    return groups;
  }
  function periodOverlap(a0,a1,b0,b1){return a0<b1&&b0<a1;}
  function removeAllGusts(groups) {
    for (const g of groups) {
      const hadGust = g.tokens?.some(t => parseWindToken(t)?.gust != null);
      if (!hadGust) continue;
      g.tokens = g.tokens.map(t => stripGustFromWind(t));
      g.hadGust = true;
    }
    return groups.filter(g => {
      if (g.kind !== 'TEMPO' || !g.hadGust) return true;
      const nonWind = (g.tokens || []).filter(t => tokenKind(t) !== 'wind');
      return nonWind.length > 0;
    });
  }
  function upsertWindGroup(groups, kind, s, e, windToken, times) {
    if (!windToken) return;
    if (kind === 'BASE') {
      const base=groups.find(g=>g.kind==='BASE');
      if (!base) return;
      base.tokens = base.tokens.filter(t=>tokenKind(t)!=='wind');
      base.tokens.unshift(windToken);
      return;
    }
    let target=groups.find(g=>g.kind===kind && finite(g.s)&&finite(g.e) && Math.abs(g.s-s)<=30*60000 && Math.abs(g.e-e)<=30*60000);
    if (!target && kind==='BECMG') {
      target=groups.find(g=>g.kind==='BECMG' && finite(g.s)&&finite(g.e) && periodOverlap(g.s,g.e,s,e));
    }
    if (target) {
      target.tokens=target.tokens.filter(t=>tokenKind(t)!=='wind');
      target.tokens.unshift(windToken);
      return;
    }
    const prefix=`${kind} ${ddhh(s)}/${ddhh(e,true)} `;
    groups.push({kind,prefix,tokens:[windToken],s,e,index:999});
  }
  function steadyWindFromRow(z) {
    if (!z) return null;
    const speed=Number(z.WS)*KT_PER_MS, dir=Number(z.WD);
    if (!finite(speed)) return null;
    return {speed,dir:finite(dir)?dir:null,vrb:!finite(dir),gust:null};
  }
  function applyGustPolicy(groups, series, times, issues) {
    groups=removeAllGusts(groups);
    const episodes=classifyGustEpisodes(series,times);
    if (!episodes.length) return {groups,episodes};
    for (const ep of episodes) {
      const rep=ep.rep;
      if (!rep) continue;
      if (ep.persistent) {
        const gustToken=formatWind(rep,true);
        const startsAtBase=ep.s<=times.start+30*60000;
        const reachesEnd=ep.e>=times.end-30*60000;
        if (startsAtBase) upsertWindGroup(groups,'BASE',times.start,times.end,gustToken,times);
        else {
          const s=Math.max(times.start,ep.s-HOUR), e=Math.min(times.end,ep.s+HOUR);
          upsertWindGroup(groups,'BECMG',s,e,gustToken,times);
        }
        if (!reachesEnd) {
          const row=nearestSeries(series,ep.e+5*60000) || nearestSeries(series,ep.e-HOUR);
          const steady=steadyWindFromRow(row);
          if (steady) {
            const s=Math.max(times.start,ep.e-HOUR), e=Math.min(times.end,ep.e+HOUR);
            upsertWindGroup(groups,'BECMG',s,e,formatWind(steady,false),times);
          }
        }
      } else {
        if (rep.speed < GUST_CHANGE_MEAN_MIN_KT) {
          issues.push({level:'warn',code:'GUST_LT15',text:`Pominięto porywy ${ddhh(ep.s)}/${ddhh(ep.e,true)}: średni wiatr ${Math.round(rep.speed)} kt < 15 kt.`});
          continue;
        }
        upsertWindGroup(groups,'TEMPO',ep.s,ep.e,formatWind(rep,true),times);
      }
    }
    return {groups,episodes};
  }
  function correctP99(groups, series, times) {
    for (const g of groups) {
      let t = times.start;
      if (g.kind==='FM') t=g.s;
      else if (g.kind==='BECMG') t=g.e;
      else if (g.kind==='TEMPO'||g.kind.startsWith('PROB30')) t=(g.s+g.e)/2;
      const z=nearestSeries(series,t);
      if (!z) continue;
      const speed=Number(z.WS)*KT_PER_MS;
      if (!finite(speed) || speed<100) continue;
      g.tokens=g.tokens.map(tok=>{
        const w=parseWindToken(tok); if(!w)return tok;
        return formatWind({...w,speed:100,speedP99:true},true);
      });
    }
  }
  function normalizeGroups(raw, options={}) {
    const issues=[];
    const times=tafTimes(raw, options.now || Date.now());
    if (!times) return {text:String(raw),issues:[{level:'error',code:'TIME',text:'Brak poprawnej grupy czasu TAF.'}],groups:[],times:null,gustEpisodes:[]};
    let lines=String(raw).split(/\n+/).map(x=>x.trim()).filter(Boolean);
    let parsed=lines.map((line,i)=>parseLine(line,i,times.issue)).filter(Boolean);
    const base=parsed.find(g=>g.kind==='BASE');
    if (!base) return {text:String(raw),issues:[{level:'error',code:'BASE',text:'Nie rozpoznano części głównej TAF EPIR.'}],groups:[],times,gustEpisodes:[]};
    // EPIR fixed local rule: both CAVOK and NSC use 1500 m (4921.26 ft).
    const cavokLimitFt = CAVOK_BASE_LIMIT_FT;
    const nscLimitFt = CAVOK_BASE_LIMIT_FT;
    let state={wind:'',vis:null,wx:[],clouds:[],cavok:false,nsc:false};
    const normalized=[];
    for (const g of parsed) {
      if (g.kind==='OTHER') continue;
      if (g.kind.includes('PROB40')) {
        issues.push({level:'error',code:'PROB40',text:'Usunięto PROB40 — w SZ RP nie stosuje się PROB40.'});
        continue;
      }
      if (g.kind==='BECMG' && finite(g.s)&&finite(g.e) && g.e-g.s>4*HOUR) {
        g.e=g.s+4*HOUR;
        g.prefix=`BECMG ${ddhh(g.s)}/${ddhh(g.e,true)} `;
        issues.push({level:'warn',code:'BECMG4H',text:'Skrócono BECMG do maksymalnych 4 h.'});
      }
      g.tokens=normalizePayload(g.payload,{kind:g.kind,previous:state,cavokLimitFt,nscLimitFt});
      if (g.kind==='FM') {
        const w=g.tokens.find(t=>tokenKind(t)==='wind') || state.wind;
        const hasCavok=g.tokens.includes('CAVOK');
        if (!hasCavok) {
          const vis=g.tokens.find(t=>tokenKind(t)==='vis') || (finite(state.vis)?(state.vis>=10000?'9999':pad(state.vis,4)):null);
          const wx=g.tokens.some(t=>tokenKind(t)==='wx')||g.tokens.includes('NSW') ? [] : state.wx.filter(t=>weatherAllowedAtVisibility(t,state.vis));
          const clouds=g.tokens.filter(t=>tokenKind(t)==='cloud');
          if (!g.tokens.some(t=>tokenKind(t)==='wind') && w) g.tokens.unshift(w);
          if (!g.tokens.some(t=>tokenKind(t)==='vis') && vis) g.tokens.push(vis);
          if (!g.tokens.some(t=>tokenKind(t)==='wx') && !g.tokens.includes('NSW')) g.tokens.push(...wx);
          if (!clouds.length && !g.tokens.includes('NSC') && state.clouds.length) g.tokens.push(...state.clouds);
          if (!g.tokens.some(t=>tokenKind(t)==='cloud') && !g.tokens.includes('NSC') && !state.clouds.length) g.tokens.push('NSC');
          g.tokens=compressCavok(reorderTokens(g.tokens),{kind:'FM',previous:state,cavokLimitFt,nscLimitFt},false);
          g.tokens=reorderTokens(g.tokens);
        }
      }
      normalized.push(g);
      if (g.kind==='BASE') state=stateFromTokens(g.tokens,null,true);
      else if (g.kind==='BECMG') state=stateFromTokens(g.tokens,state,false);
      else if (g.kind==='FM') state=stateFromTokens(g.tokens,null,true);
    }
    let groups=mergeSameGroups(normalized);
    const gustResult=applyGustPolicy(groups,options.series||[],times,issues);
    groups=mergeSameGroups(gustResult.groups);
    correctP99(groups,options.series||[],times);
    groups=limitGroups(groups,issues);
    for (const g of groups) g.tokens=reorderTokens(g.tokens || []);
    const out=[];
    for (const g of groups) out.push((g.prefix + g.tokens.join(' ')).replace(/\s+/g,' ').trim());
    const text=out.join('\n')+'=';
    return {text,issues,groups,times,gustEpisodes:gustResult.episodes};
  }
  function validate(text, options={}) {
    const issues=[];
    const raw=String(text||'');
    const times=tafTimes(raw,options.now||Date.now());
    if (!times) issues.push({level:'error',code:'TIME',text:'Niepoprawny czas wydania/ważności.'});
    else {
      const plain=!/^TAF\s+(?:AMD|COR)\b/.test(raw);
      if (Math.round((times.end-times.start)/HOUR)!==12) issues.push({level:'error',code:'VALIDITY12',text:'Okres ważności nie wynosi 12 h.'});
      if (plain && Math.round((times.start-times.issue)/HOUR)!==1) issues.push({level:'error',code:'ISSUE1H',text:'Zwykły TAF powinien być wydany 1 h przed początkiem ważności.'});
    }
    if (/\bPROB40\b/.test(raw)) issues.push({level:'error',code:'PROB40',text:'PROB40 jest zabronione.'});
    if (/\bVV(?:\d{3}|\/\/\/)\b/.test(raw)) issues.push({level:'error',code:'VV',text:'Widzialności pionowej VV nie prognozuje się w TAF SZ RP.'});
    if (/\b(?:MIFG|BCFG|PRFG)\b/.test(raw)) issues.push({level:'error',code:'FOG_QUALIFIER',text:'MI/BC/PR dla mgły nie są dopuszczone w TAF.'});
    const changeCount=(raw.match(/(?:^|\n)(?:BECMG|TEMPO|PROB30|FM\d{6})\b/g)||[]).length;
    if (changeCount>MAX_CHANGE_GROUPS) issues.push({level:'error',code:'GROUPS5',text:`Liczba grup zmian ${changeCount} > 5.`});
    for (const m of raw.matchAll(/\b(VRB|\d{3})(P99|\d{2,3})(?:G(P99|\d{2,3}))?KT\b/g)) {
      const w=parseWindToken(m[0]);
      if (w?.gust!=null && w.gust-w.speed<GUST_GAP_KT) issues.push({level:'error',code:'GUST10',text:`${m[0]}: poryw < 10 kt ponad średnią.`});
    }
    for (const m of raw.matchAll(/\b(\d{4})\b/g)) {
      const c=m[1];
      const pos=m.index||0, before=raw[pos-1]||'', after=raw[pos+4]||'';
      if (before==='/'||after==='/'||after==='Z') continue;
      const n=Number(c);
      if (c==='9999') continue;
      const norm=normalizeVisibilityCode(c);
      if (norm!==c) issues.push({level:'error',code:'VIS_STEP',text:`Widzialność ${c} nie leży na kroku kodowania; oczekiwano ${norm}.`});
      if (n>9000) issues.push({level:'error',code:'VIS9999',text:`Widzialność ${c} powinna być 9999 dla 10 km lub więcej.`});
    }
    const nscLimitFt=CAVOK_BASE_LIMIT_FT;
    if (/\b(?:FEW|SCT|BKN|OVC)\d{3}(?!CB\b|TCU\b)/.test(raw)) {
      for (const m of raw.matchAll(/\b(?:FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)) {
        const ft=Number(m[1])*100;
        if (!m[2] && ft>=nscLimitFt) issues.push({level:'warn',code:'HIGH_CLOUD',text:`${m[0]}: zwykła warstwa jest powyżej progu istotności NSC (${Math.round(nscLimitFt)} ft).`});
      }
    }
    return issues;
  }
  function normalize(raw, options={}) {
    const first=normalizeGroups(raw,options);
    const validation=validate(first.text,options);
    return {...first,validation,allIssues:[...first.issues,...validation]};
  }
  function getSeriesFromPage(times) {
    if (typeof document==='undefined') return [];
    const frame=document.getElementById('engine');
    const w=frame?.contentWindow;
    if (!w) return [];
    try {
      const data=w.eval(`consensus.map(z=>({t:z.t,WS:z.WS,WD:z.WD,G:z.G,count:z.count}))`);
      return Array.isArray(data) ? data.filter(z=>finite(z?.t)&&z.t>=times.start&&z.t<times.end) : [];
    } catch (_) { return []; }
  }
  function updateUi(result) {
    if (typeof document==='undefined') return;
    const $=id=>document.getElementById(id);
    const all=result.allIssues||[];
    const errors=all.filter(x=>x.level==='error');
    const warnings=all.filter(x=>x.level==='warn');
    const sources=$('sources');
    if (sources) {
      sources.querySelectorAll('[data-taf-instruction-guard]').forEach(x=>x.remove());
      const pill=document.createElement('span');
      pill.dataset.tafInstructionGuard='1';
      pill.className='pill '+(errors.length?'bad':warnings.length?'warn':'ok');
      pill.textContent=errors.length?`TAF 11.2023: ${errors.length} błąd`:warnings.length?`TAF 11.2023: ${warnings.length} uwag`:'TAF 11.2023 ✓';
      sources.appendChild(pill);
      const units=document.createElement('span');
      units.dataset.tafInstructionGuard='1';
      units.className='pill ok';
      units.textContent='EPIR: CAVOK/NSC 1500 m · 4921 ft ✓';
      sources.appendChild(units);
    }
    const checks=$('checks');
    if (checks) {
      checks.querySelectorAll('[data-taf-instruction-guard]').forEach(x=>x.remove());
      const basic=[
        ['PROB40',!/\bPROB40\b/.test(result.text)],
        ['VV',!/\bVV(?:\d{3}|\/\/\/)\b/.test(result.text)],
        ['MI/BC/PR fog',!/\b(?:MIFG|BCFG|PRFG)\b/.test(result.text)],
        ['≤ 5 grup zmian',(result.groups?.length||1)-1<=MAX_CHANGE_GROUPS]
      ];
      for (const [label,ok] of basic) {
        const li=document.createElement('li');li.dataset.tafInstructionGuard='1';li.className=ok?'ok':'bad';li.textContent=`${label}: ${ok?'OK':'BŁĄD'}`;checks.appendChild(li);
      }
      for (const i of all.slice(0,8)) {
        const li=document.createElement('li');li.dataset.tafInstructionGuard='1';li.className=i.level==='error'?'bad':'warn';li.textContent=i.text;checks.appendChild(li);
      }
    }
    const reasons=$('reasons');
    if (reasons) {
      reasons.querySelectorAll('[data-taf-gust-2023]').forEach(x=>x.remove());
      let ul=reasons.querySelector('ul');
      if (!ul) {ul=document.createElement('ul');reasons.appendChild(ul);}
      for (const ep of result.gustEpisodes||[]) {
        const li=document.createElement('li');li.dataset.tafGust2023='1';
        if (ep.persistent) li.textContent=`Porywy ${ddhh(ep.s)}/${ddhh(ep.e,true)}: silny wiatr >=15 kt utrzymuje się ${ep.durationH.toFixed(1)} h (>=4 h) — poryw traktowany jako warunek przeważający.`;
        else if (ep.rep?.speed>=GUST_CHANGE_MEAN_MIN_KT) li.textContent=`Porywy ${ddhh(ep.s)}/${ddhh(ep.e,true)}: epizod <4 h — poryw kodowany w TEMPO.`;
        else li.textContent=`Porywy ${ddhh(ep.s)}/${ddhh(ep.e,true)}: średni wiatr <15 kt — sam poryw nie tworzy grupy zmian.`;
        ul.appendChild(li);
      }
    }
  }
  const api=Object.freeze({
    constants:Object.freeze({HOUR,KT_PER_MS,FT_PER_M,CAVOK_BASE_LIMIT_M,CAVOK_BASE_LIMIT_FT,NSC_LIMIT_FT,CEILING_THRESHOLDS_FT,VIS_THRESHOLDS_M,GUST_GAP_KT,GUST_CHANGE_MEAN_MIN_KT,PERSISTENT_GUST_HOURS,MAX_CHANGE_GROUPS}),
    visibilityBand,ceilingBandFt,normalizeVisibilityValue,normalizeVisibilityCode,parseWindToken,formatWind,parseCloudToken,selectCloudLayers,tafTimes,classifyGustEpisodes,normalize,validate
  });
  if (typeof module!=='undefined' && module.exports) module.exports=api;
  if (typeof window!=='undefined') window.PrognozaEPIRTAFInstruction2023=api;
  if (typeof document==='undefined' || typeof location==='undefined' || !/\/taf\.html$/i.test(location.pathname)) return;
  let applying=false,last='';let timer=0;
  function apply(){
    if(applying)return;
    const el=document.getElementById('taf');
    const current=el?.textContent?.trim()||'';
    if(!/^TAF\s+(?:AMD\s+|COR\s+)?EPIR\b/.test(current)||current===last)return;
    const times=tafTimes(current);if(!times)return;
    const series=getSeriesFromPage(times);
    const result=normalize(current,{series});
    updateUi(result);
    if(result.text===current){last=current;return;}
    applying=true;el.textContent=result.text;last=result.text;applying=false;
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(apply,420);}
  function install(){
    const el=document.getElementById('taf');if(!el)return;
    new MutationObserver(schedule).observe(el,{childList:true,characterData:true,subtree:true});
    schedule();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
