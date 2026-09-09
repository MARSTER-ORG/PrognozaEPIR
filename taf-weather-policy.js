'use strict';
(() => {
  if (!/\btaf\.html$/i.test(location.pathname)) return;

  const HOUR = 3600e3;
  const MAX_CHANGE_GROUPS = 5;
  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad = (v, n = 2) => String(Math.round(v)).padStart(n, '0');

  let applying = false;
  let lastOutput = '';
  let scheduled = 0;

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
    let end = monthTime(validity[2], start + 6 * HOUR);
    if (end <= start) end = monthTime(validity[2], start + 18 * HOUR);
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

  function getSeries(times) {
    const frame = $('engine');
    const w = frame?.contentWindow;
    if (!w) return [];
    try {
      const data = w.eval(`consensus.map(z=>({t:z.t,RR:z.RR,wet:z.wet,storm:z.storm,VIS:z.VIS,RH:z.RH,T:z.T,Td:z.Td,count:z.count}))`);
      if (!Array.isArray(data)) return [];
      return data.filter(z => finite(z?.t) && z.t >= times.start && z.t < times.end).sort((a,b) => a.t - b.t);
    } catch (_) {
      return [];
    }
  }

  function quantile(values, q) {
    const a = values.filter(finite).sort((x,y) => x-y);
    if (!a.length) return NaN;
    if (a.length === 1) return a[0];
    const p = (a.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return a[lo] + (a[hi] - a[lo]) * (p - lo);
  }

  function plainRainToken(token) {
    return /^(?:-)?RA$/.test(String(token || ''));
  }

  function rainPoint(z) {
    const rr = Number(z.RR), storm = Number(z.storm), wet = Number(z.wet);
    if (!finite(rr) || rr < 0.1) return null;
    // Konwekcja jest obsługiwana przez osobną politykę TCU/CB, więc nie tworzymy
    // tu konkurencyjnych grup zwykłego RA dla tego samego okresu.
    if (finite(storm) && storm >= 50) return null;
    const support = finite(wet) ? clamp(wet, 0, 100) : (rr >= 0.3 ? 50 : 40);
    if (support < 30) return null;
    return {t:z.t, rr, support, row:z};
  }

  function makeEpisodes(series, times) {
    const points = series.map(rainPoint).filter(Boolean);
    const groups = [];
    for (const p of points) {
      const last = groups.at(-1);
      if (last && p.t - last.lastT <= 90 * 60000) {
        last.points.push(p);
        last.lastT = p.t;
      } else {
        groups.push({points:[p], lastT:p.t});
      }
    }
    return groups.map(g => {
      const rr = g.points.map(x => x.rr);
      const supports = g.points.map(x => x.support);
      const moderate = rr.filter(x => x >= 0.3).length;
      const meanRR = rr.reduce((a,b) => a+b, 0) / rr.length;
      const moderateShare = moderate / rr.length;
      // Jednogodzinne osłabienie do -RA wewnątrz przeważającego okresu RA
      // nie rozcina epizodu. Wybieramy charakter reprezentatywny dla całości.
      const token = moderateShare >= 0.5 || meanRR >= 0.3 ? 'RA' : '-RA';
      return {
        s:g.points[0].t,
        e:Math.min(times.end, g.points.at(-1).t + HOUR),
        points:g.points,
        support:quantile(supports, .5),
        meanRR,
        moderateShare,
        token
      };
    });
  }

  function parseGroup(line, ref) {
    const m = String(line).match(/^(BECMG|TEMPO|PROB30(?:\s+TEMPO)?)\s+(\d{4})\/(\d{4})(?:\s+(.*))?$/);
    if (!m) return null;
    const s = monthTime(m[2], ref), rawEnd = monthTime(m[3], s + 2 * HOUR);
    const e = rawEnd <= s ? monthTime(m[3], s + 12 * HOUR) : rawEnd;
    return {kind:m[1], s, e, payload:(m[4] || '').trim()};
  }

  function stripCoreBecmgRain(lines) {
    let removed = 0;
    const out = [];
    lines.forEach((line, i) => {
      if (i === 0 || !/^BECMG\b/.test(line)) { out.push(line); return; }
      const m = line.match(/^(BECMG\s+\d{4}\/\d{4})(?:\s+(.*))?$/);
      if (!m) { out.push(line); return; }
      const tokens = (m[2] || '').split(/\s+/).filter(Boolean);
      const kept = tokens.filter(t => !plainRainToken(t));
      removed += tokens.length - kept.length;
      if (kept.length) out.push(`${m[1]} ${kept.join(' ')}`);
    });
    return {lines:out, removed};
  }

  function setBaseRain(line, token) {
    const m = String(line).match(/^(TAF(?:\s+(?:AMD|COR))?\s+EPIR\s+\d{6}Z\s+\d{4}\/\d{4}\s+)(.*)$/);
    if (!m) return line;
    let tokens = m[2].trim().split(/\s+/).filter(Boolean).filter(t => !plainRainToken(t));
    if (!token) return m[1] + tokens.join(' ');

    const cav = tokens.indexOf('CAVOK');
    if (cav >= 0) {
      tokens[cav] = '9999';
      if (!tokens.some(t => /^(?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)?$/.test(t) || t === 'NSC')) tokens.push('NSC');
    }
    let at = tokens.findIndex(t => /^(?:9999|\d{4})$/.test(t));
    if (at < 0) at = tokens.findIndex(t => /KT$/.test(t));
    tokens.splice(Math.max(0, at + 1), 0, token);
    return m[1] + tokens.join(' ');
  }

  function overlap(a0, a1, b0, b1) { return a0 < b1 && b0 < a1; }

  function appendPayload(line, token) {
    if (!token) return line;
    const m = String(line).match(/^((?:BECMG|TEMPO|PROB30(?:\s+TEMPO)?)\s+\d{4}\/\d{4})(?:\s+(.*))?$/);
    if (!m) return line;
    const tokens = (m[2] || '').split(/\s+/).filter(Boolean);
    if (tokens.includes(token)) return line;
    const cloud = tokens.findIndex(t => /^(?:FEW|SCT|BKN|OVC)\d{3}(?:CB|TCU)?$/.test(t) || /^VV/.test(t) || t === 'NSC');
    const at = cloud >= 0 ? cloud : tokens.length;
    tokens.splice(at, 0, token);
    return `${m[1]} ${tokens.join(' ')}`.replace(/\s+/g, ' ').trim();
  }

  function findMergeIndex(lines, kind, s, e, times, tolerance = HOUR) {
    let best = -1, score = Infinity;
    for (let i = 1; i < lines.length; i++) {
      const g = parseGroup(lines[i], times.issue);
      if (!g || g.kind !== kind) continue;
      const centerA = (g.s + g.e) / 2, centerB = (s + e) / 2;
      if (kind === 'BECMG') {
        if (!overlap(g.s, g.e, s, e) && Math.abs(centerA - centerB) > tolerance) continue;
      } else {
        if (Math.abs(g.s - s) > 30 * 60000 || Math.abs(g.e - e) > 30 * 60000) continue;
      }
      const d = Math.abs(centerA - centerB);
      if (d < score) { score = d; best = i; }
    }
    return best;
  }

  function addOrMerge(lines, kind, s, e, payload, times) {
    const idx = findMergeIndex(lines, kind, s, e, times);
    if (idx >= 0) {
      lines[idx] = appendPayload(lines[idx], payload);
      return true;
    }
    if (lines.length - 1 >= MAX_CHANGE_GROUPS) return false;
    lines.push(`${kind} ${ddhh(s)}/${ddhh(e, true)} ${payload}`.replace(/\s+/g, ' ').trim());
    return true;
  }

  function hasWeatherChangeNear(lines, t, times, token = null) {
    return lines.slice(1).some(line => {
      const g = parseGroup(line, times.issue);
      if (!g || Math.abs(((g.s + g.e) / 2) - t) > 90 * 60000) return false;
      if (!token) return /\b(?:NSW|FG|BR|HZ|FZFG|FZRA|FZDZ|TS|TSRA|SHRA|SHSN|SN|RASN|SNRA)\b/.test(g.payload);
      return g.payload.split(/\s+/).includes(token);
    });
  }

  function nextWeather(series, t) {
    const z = series.find(x => x.t >= t - 5 * 60000);
    if (!z) return 'NSW';
    const storm = Number(z.storm), vis = Number(z.VIS), rh = Number(z.RH), temp = Number(z.T);
    if (finite(storm) && storm >= 50) return null; // konwekcję opisze moduł CB/TCU
    if (finite(vis) && vis <= 900 && finite(rh) && rh >= 90) return finite(temp) && temp <= 0 ? 'FZFG' : 'FG';
    if (finite(vis) && vis <= 5000 && finite(rh) && rh >= 88) return 'BR';
    return 'NSW';
  }

  function sortGroups(lines, times) {
    const base = lines.shift();
    lines.sort((a,b) => {
      const A = parseGroup(a, times.issue), B = parseGroup(b, times.issue);
      return (A?.s ?? Infinity) - (B?.s ?? Infinity) || (A?.e ?? Infinity) - (B?.e ?? Infinity);
    });
    return [base, ...lines];
  }

  function optimize(raw, series, times) {
    let lines = String(raw).split(/\n+/).map(x => x.trim().replace(/=$/, '')).filter(Boolean);
    if (!lines.length) return {raw, reasons:[], changed:false};

    const cleaned = stripCoreBecmgRain(lines);
    lines = cleaned.lines;
    const episodes = makeEpisodes(series, times);
    const reasons = [];

    // Bazowy RA/-RA pochodzi z warunków przeważających na początku TAF.
    const first = episodes[0];
    const startsAtBase = first && first.s <= times.start + 30 * 60000;
    if (startsAtBase) {
      if (first.support >= 50) {
        lines[0] = setBaseRain(lines[0], first.token);
      } else {
        lines[0] = setBaseRain(lines[0], null);
      }
    } else {
      // Jeżeli rdzeń wpisał opad do grupy głównej na podstawie samego RR,
      // a nie ma większościowego poparcia modeli na początku okresu, usuń go.
      const baseRow = series[0], bp = baseRow ? rainPoint(baseRow) : null;
      if (!bp || bp.support < 50) lines[0] = setBaseRain(lines[0], null);
    }

    for (const ep of episodes) {
      const atBase = ep.s <= times.start + 30 * 60000;
      const durationH = (ep.e - ep.s) / HOUR;
      const pctModerate = Math.round(ep.moderateShare * 100);
      const support = Math.round(ep.support);

      if (ep.support < 50) {
        if (ep.token === 'RA') {
          const ok = addOrMerge(lines, 'PROB30', ep.s, ep.e, 'RA', times);
          if (ok) reasons.push(`PROB30 ${ddhh(ep.s)}/${ddhh(ep.e,true)} RA: opad umiarkowany ma ~${support}% poparcia modeli; nie tworzę trwałego BECMG.`);
        } else {
          reasons.push(`Pominięto samodzielne -RA ${ddhh(ep.s)}/${ddhh(ep.e,true)}: słaby opad bez innego kryterium nie powinien zużywać osobnej grupy zmian.`);
        }
        continue;
      }

      if (atBase) {
        reasons.push(`Opad od początku okresu: ${ep.token} jako warunek przeważający; ${pctModerate}% godzin epizodu spełnia próg RA, poparcie modeli ~${support}%.`);
      } else if (ep.token === '-RA') {
        reasons.push(`Pominięto osobną grupę dla -RA ${ddhh(ep.s)}/${ddhh(ep.e,true)}: słaby opad zostaje tylko w części głównej lub „przy okazji” innej istotnej zmiany.`);
        continue;
      } else if (ep.points.length === 1 && durationH <= 1.1) {
        // Jedyny przypadek, w którym z siatki godzinowej wnioskujemy o epizodzie
        // przejściowym: pojedyncza mokra godzina otoczona warunkami bez opadu.
        const s = Math.max(times.start, ep.s - HOUR);
        const e = Math.min(times.end, ep.e + HOUR);
        if (e - s >= 3 * HOUR) {
          const ok = addOrMerge(lines, 'TEMPO', s, e, 'RA', times);
          if (ok) reasons.push(`TEMPO ${ddhh(s)}/${ddhh(e,true)} RA: pojedynczy izolowany sygnał opadu; nie traktuję go jako nowego stanu przeważającego.`);
          continue;
        }
        const bs = Math.max(times.start, ep.s - HOUR);
        const be = Math.min(times.end, ep.s + HOUR);
        const ok = addOrMerge(lines, 'BECMG', bs, be, 'RA', times);
        if (ok) reasons.push(`BECMG ${ddhh(bs)}/${ddhh(be,true)} RA: izolowany sygnał leży zbyt blisko granicy ważności, aby poprawnie zbudować okno TEMPO.`);
      } else {
        const s = Math.max(times.start, ep.s - HOUR);
        const e = Math.min(times.end, ep.s + HOUR);
        const ok = addOrMerge(lines, 'BECMG', s, e, 'RA', times);
        if (ok) reasons.push(`BECMG ${ddhh(s)}/${ddhh(e,true)} RA: jeden reprezentatywny epizod (${pctModerate}% godzin jako RA, poparcie ~${support}%); wahania RA↔-RA wewnątrz epizodu są scalone.`);
      }

      // Jeśli przeważający RA rzeczywiście kończy się wyraźnie przed końcem TAF,
      // potrzebna jest zmiana kończąca stan. Nie tworzymy natomiast BECMG -RA.
      if (ep.token === 'RA' && ep.e < times.end - 30 * 60000) {
        const endWx = nextWeather(series, ep.e);
        if (endWx && !hasWeatherChangeNear(lines, ep.e, times, endWx)) {
          const s2 = Math.max(times.start, ep.e - HOUR);
          const e2 = Math.min(times.end, ep.e + HOUR);
          const ok2 = addOrMerge(lines, 'BECMG', s2, e2, endWx, times);
          if (ok2) reasons.push(`Koniec przeważającego RA około ${ddhh(ep.e)}: ${endWx}; nie używam BECMG -RA jako sztucznego „schodka” intensywności.`);
        }
      }
    }

    lines = sortGroups(lines, times);
    // Idempotencja i minimalizacja prostych duplikatów.
    lines = lines.filter((line, i, a) => i === 0 || a.indexOf(line) === i);
    if (cleaned.removed) reasons.unshift(`Usunięto ${cleaned.removed} surowe przejścia RA/-RA z BECMG i przebudowano je jako spójne epizody pogodowe.`);

    const output = lines.join('\n').replace(/\s+$/gm, '') + '=';
    return {raw:output, reasons, changed:output !== String(raw).trim()};
  }

  function updateUi(reasons) {
    const box = $('reasons');
    if (box) {
      box.querySelectorAll('[data-weather-reason]').forEach(x => x.remove());
      if (reasons.length) {
        let ul = box.querySelector('ul');
        if (!ul) { ul = document.createElement('ul'); box.appendChild(ul); }
        for (const text of reasons) {
          const li = document.createElement('li');
          li.dataset.weatherReason = '1';
          li.textContent = text;
          ul.appendChild(li);
        }
      }
    }
    const sources = $('sources');
    if (sources && !sources.querySelector('[data-weather-policy]')) {
      const p = document.createElement('span');
      p.className = 'pill ok';
      p.dataset.weatherPolicy = '1';
      p.textContent = 'TAF WX optimizer ✓';
      sources.appendChild(p);
    }
    const checks = $('checks');
    if (checks) {
      checks.querySelectorAll('[data-weather-check]').forEach(x => x.remove());
      const current = $('taf')?.textContent || '';
      const badStep = /BECMG\s+\d{4}\/\d{4}\s+-RA\b/.test(current);
      const li = document.createElement('li');
      li.dataset.weatherCheck = '1';
      li.className = badStep ? 'bad' : 'ok';
      li.textContent = `RA/-RA bez zbędnego BECMG: ${badStep ? 'BŁĄD' : 'OK'}`;
      checks.appendChild(li);
    }
  }

  function applyPolicy() {
    if (applying) return;
    const el = $('taf');
    const current = el?.textContent?.trim() || '';
    if (!/^TAF\s+EPIR\b/.test(current) || current === lastOutput) return;
    const times = tafTimes(current);
    if (!times) return;
    const series = getSeries(times);
    if (series.length < 4) return;

    const result = optimize(current, series, times);
    updateUi(result.reasons);
    if (!result.changed) { lastOutput = current; return; }
    applying = true;
    el.textContent = result.raw;
    lastOutput = result.raw;
    applying = false;
  }

  function schedule() {
    clearTimeout(scheduled);
    scheduled = setTimeout(applyPolicy, 140);
  }

  function install() {
    const el = $('taf');
    if (!el) return;
    new MutationObserver(schedule).observe(el, {childList:true, characterData:true, subtree:true});
    schedule();
  }

  window.PrognozaEPIRTAFWeatherPolicy = Object.freeze({optimize});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();
