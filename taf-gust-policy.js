'use strict';
(() => {
  if (!/\btaf\.html$/i.test(location.pathname)) return;

  const KT_PER_MS = 1.94384;
  const GUST_GAP_KT = 10;
  const MAX_CHANGE_GROUPS = 5;
  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad = (v, n = 2) => String(Math.round(v)).padStart(n, '0');

  let applying = false;
  let lastOutput = '';

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
    return {issue:issueMs, start, end};
  }

  function ddhh(ms, end = false) {
    const d = new Date(ms);
    if (end && d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
      const q = new Date(ms - 1);
      return pad(q.getUTCDate()) + '24';
    }
    return pad(d.getUTCDate()) + pad(d.getUTCHours());
  }

  function parseGroupPeriod(line, ref) {
    const m = String(line).match(/\b(\d{4})\/(\d{4})\b/);
    if (!m) return null;
    const s = monthTime(m[1], ref);
    let e = monthTime(m[2], s + 2 * 3600e3);
    if (e <= s) e = monthTime(m[2], s + 12 * 3600e3);
    return {s,e};
  }

  function getSeries(times) {
    const frame = $('engine');
    const w = frame?.contentWindow;
    if (!w) return [];
    try {
      const data = w.eval(`consensus.map(z=>({t:z.t,WS:z.WS,WD:z.WD,G:z.G,count:z.count}))`);
      return Array.isArray(data) ? data.filter(z => finite(z?.t) && z.t >= times.start && z.t < times.end) : [];
    } catch (_) {
      return [];
    }
  }

  function parseWind(text) {
    const m = String(text || '').match(/\b(VRB|\d{3})(\d{2,3})(?:G(P99|\d{2,3}))?KT\b/);
    if (!m) return null;
    return {
      dir:m[1] === 'VRB' ? null : Number(m[1]),
      vrb:m[1] === 'VRB',
      speed:Number(m[2]),
      gust:m[3] ? (m[3] === 'P99' ? 100 : Number(m[3])) : null
    };
  }

  function circular(a, b) {
    if (!finite(a) || !finite(b)) return 180;
    let x = Math.abs(a - b) % 360;
    return x > 180 ? 360 - x : x;
  }

  function steadyWindSignificant(a, b) {
    if (!a || !b) return true;
    if (Math.abs((b.speed || 0) - (a.speed || 0)) >= 10) return true;
    if (a.vrb !== b.vrb) return Math.max(a.speed || 0, b.speed || 0) >= 5;
    if (!a.vrb && !b.vrb && circular(a.dir, b.dir) >= 60 && Math.max(a.speed || 0, b.speed || 0) >= 10) return true;
    return false;
  }

  function stripGustToken(text) {
    return String(text).replace(/\b((?:VRB|\d{3})\d{2,3})G(?:P99|\d{2,3})KT\b/g, '$1KT');
  }

  function removePrevailingGusts(raw) {
    const input = String(raw).split(/\n+/).map(x => x.trim()).filter(Boolean);
    if (!input.length) return raw;
    const out = [];
    let prevailing = parseWind(stripGustToken(input[0]));
    out.push(stripGustToken(input[0]).replace(/\s+/g, ' ').trim());

    for (let i = 1; i < input.length; i++) {
      const original = input[i];
      const hadGust = /\b(?:VRB|\d{3})\d{2,3}G(?:P99|\d{2,3})KT\b/.test(original);
      let line = stripGustToken(original).replace(/\s+/g, ' ').trim();
      const b = line.match(/^BECMG\s+\d{4}\/\d{4}\s+(.+)$/);
      const w = parseWind(line);
      if (b && hadGust && w) {
        const onlyWind = /^(?:VRB|\d{3})\d{2,3}KT$/.test(b[1].trim());
        if (onlyWind && prevailing && !steadyWindSignificant(prevailing, w)) continue;
      }
      out.push(line);
      if ((/^BECMG\b/.test(line) || /^FM\d{6}\b/.test(line)) && w) prevailing = w;
    }
    return out.join('\n');
  }

  function quantile(values, q) {
    const a = values.filter(finite).sort((x,y) => x-y);
    if (!a.length) return NaN;
    if (a.length === 1) return a[0];
    const p = (a.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return a[lo] + (a[hi] - a[lo]) * (p - lo);
  }

  function representative(group) {
    let u = 0, v = 0, sw = 0, speedNum = 0, speedDen = 0;
    const gusts = [];
    for (const e of group.events) {
      const w = finite(e.weight) ? e.weight : 1;
      speedNum += e.speedKt * w;
      speedDen += w;
      gusts.push(e.gustKt);
      if (finite(e.dir)) {
        const r = e.dir * Math.PI / 180;
        const s = Math.max(1, e.speedKt) * w;
        u += -Math.sin(r) * s;
        v += -Math.cos(r) * s;
        sw += s;
      }
    }
    let dir = null;
    if (sw > 0) dir = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
    const speed = Math.max(1, Math.round(speedDen ? speedNum / speedDen : group.events[0].speedKt));
    const gust75 = quantile(gusts, .75);
    const gust = Math.max(speed + GUST_GAP_KT, Math.round(finite(gust75) ? gust75 : Math.max(...gusts)));
    const d = finite(dir) ? (Math.round(dir / 10) * 10) % 360 : null;
    const dirCode = d === null ? 'VRB' : pad(d === 0 ? 360 : d, 3);
    const speedCode = pad(Math.min(speed, 99), 2);
    const gustCode = gust > 99 ? 'P99' : pad(gust, 2);
    return {dir:d, speed, gust, token:`${dirCode}${speedCode}G${gustCode}KT`};
  }

  function gustGroups(series, endMs) {
    const events = [];
    for (const z of series) {
      const ws = Number(z.WS), g = Number(z.G), wd = Number(z.WD);
      if (!finite(ws) || !finite(g)) continue;
      const speedKt = ws * KT_PER_MS, gustKt = g * KT_PER_MS;
      if (gustKt - speedKt < GUST_GAP_KT) continue;
      const count = Number(z.count);
      events.push({
        t:z.t,
        speedKt,
        gustKt,
        dir:finite(wd) ? wd : null,
        weight:finite(count) ? clamp(count / 8, .75, 1.25) : 1
      });
    }
    const out = [];
    for (const e of events.sort((a,b) => a.t-b.t)) {
      const last = out.at(-1);
      if (last && e.t - last.lastT <= 90 * 60000) {
        last.events.push(e);
        last.lastT = e.t;
        last.e = Math.min(endMs, e.t + 3600e3);
      } else {
        out.push({s:e.t, e:Math.min(endMs, e.t + 3600e3), lastT:e.t, events:[e]});
      }
    }
    for (const g of out) Object.assign(g, representative(g));
    return out;
  }

  function insertWindIntoTempo(line, token) {
    const m = String(line).match(/^(TEMPO\s+\d{4}\/\d{4}\s+)(.*)$/);
    if (!m) return line;
    let payload = m[2].trim();
    if (/\b(?:VRB|\d{3})\d{2,3}(?:G(?:P99|\d{2,3}))?KT\b/.test(payload)) return line;
    return (m[1] + token + ' ' + payload).replace(/\s+/g, ' ').trim();
  }

  function addGustGroups(raw, groups, times) {
    let lines = removePrevailingGusts(raw).split(/\n+/).map(x => x.trim()).filter(Boolean);
    if (!groups.length) return lines.join('\n');
    let changeCount = Math.max(0, lines.length - 1);

    for (const g of groups) {
      const period = `${ddhh(g.s)}/${ddhh(g.e, true)}`;
      let merged = false;
      for (let i = 1; i < lines.length; i++) {
        if (!/^TEMPO\b/.test(lines[i]) || /^PROB30\s+TEMPO\b/.test(lines[i])) continue;
        const p = parseGroupPeriod(lines[i], times.issue);
        if (!p || p.s !== g.s || p.e !== g.e) continue;
        const updated = insertWindIntoTempo(lines[i], g.token);
        if (updated !== lines[i]) {
          lines[i] = updated;
          merged = true;
        }
        break;
      }
      if (merged) continue;
      if (changeCount >= MAX_CHANGE_GROUPS) continue;
      lines.push(`TEMPO ${period} ${g.token}`);
      changeCount++;
    }

    const base = lines.shift();
    lines.sort((a,b) => {
      const pa = parseGroupPeriod(a, times.issue), pb = parseGroupPeriod(b, times.issue);
      return (pa?.s || Infinity) - (pb?.s || Infinity);
    });
    return [base, ...lines].join('\n');
  }

  function addExplanation(groups) {
    const box = $('reasons');
    if (box) {
      box.querySelectorAll('[data-gust-reason]').forEach(x => x.remove());
      if (groups.length) {
        let ul = box.querySelector('ul');
        if (!ul) {
          ul = document.createElement('ul');
          box.appendChild(ul);
        }
        for (const g of groups) {
          const li = document.createElement('li');
          li.dataset.gustReason = '1';
          li.textContent = `TEMPO ${ddhh(g.s)}/${ddhh(g.e,true)} ${g.token}: porywy są traktowane jako zjawisko przejściowe w prognozowanym przedziale, a nie jako ciągły składnik wiatru.`;
          ul.appendChild(li);
        }
      }
    }
    const sources = $('sources');
    if (sources && !sources.querySelector('[data-gust-policy]')) {
      const p = document.createElement('span');
      p.className = 'pill ok';
      p.dataset.gustPolicy = '1';
      p.textContent = 'porywy → TEMPO ✓';
      sources.appendChild(p);
    }
    const conf = $('conf');
    if (conf && !/Porywy: TEMPO/.test(conf.textContent)) conf.textContent += ' Porywy: TEMPO w prognozowanym okresie; nie są utrzymywane jako warunek ciągły.';
  }

  function applyPolicy() {
    if (applying) return;
    const el = $('taf');
    const current = el?.textContent?.trim() || '';
    if (!/^TAF\s+EPIR\b/.test(current) || current === lastOutput) return;
    const times = tafTimes(current);
    if (!times) return;
    const series = getSeries(times);
    if (!series.length) return;
    const groups = gustGroups(series, times.end);
    const output = addGustGroups(current, groups, times);
    addExplanation(groups);
    if (output === current) {
      lastOutput = current;
      return;
    }
    applying = true;
    el.textContent = output;
    lastOutput = output;
    applying = false;
  }

  function install() {
    const el = $('taf');
    if (!el) return;
    new MutationObserver(() => setTimeout(applyPolicy, 0)).observe(el, {childList:true, characterData:true, subtree:true});
    setTimeout(applyPolicy, 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();
