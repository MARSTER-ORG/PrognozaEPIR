'use strict';
(() => {
  if (!/\/taf\.html$/i.test(location.pathname)) return;

  // Instrukcja TAF 3.8.9-3.8.10: zwykłe chmury od 5000 ft wzwyż
  // nie są kodowane jako chmury o znaczeniu operacyjnym. Wyjątek: CB/TCU.
  const SIG_CLOUD_FT = 5000;
  const $ = id => document.getElementById(id);
  let applying = false;
  let last = '';
  let timer = 0;

  function cloud(tok) {
    const m = String(tok || '').match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/);
    return m ? {ft:+m[2] * 100, type:m[3] || ''} : null;
  }

  function isVis(tok) {
    return /^\d{4}$/.test(tok);
  }

  function isWx(tok) {
    const t = String(tok || '').replace(/^[-+]/, '');
    if (!t || t === 'NSW') return false;
    if (/^(?:FG|BR|SA|DU|HZ|FU|VA|SQ|PO|FC|BCFG|BLDU|BLSA|BLSN|DRDU|DRSA|DRSN|FZFG|MIFG|PRFG|TS)$/.test(t)) return true;
    if (/^(?:FZ)?(?:DZ|RA|SN|SG|PL|GR|GS){1,3}$/.test(t)) return true;
    if (/^(?:SH|TS)(?:DZ|RA|SN|SG|PL|GR|GS){1,3}$/.test(t)) return true;
    return false;
  }

  function splitLine(line) {
    const base = String(line).match(/^(TAF(?:\s+(?:AMD|COR))?\s+EPIR\s+\d{6}Z\s+\d{4}\/\d{4}\s+)(.*)$/);
    if (base) return {kind:'BASE', prefix:base[1], body:base[2]};
    const change = String(line).match(/^((?:PROB30\s+TEMPO|PROB30|BECMG|TEMPO)\s+\d{4}\/\d{4}\s+|FM\d{6}\s+)(.*)$/);
    if (change) {
      const first = change[1].trim().split(/\s+/)[0];
      const kind = first === 'PROB30' ? (change[1].includes('TEMPO') ? 'PROB30 TEMPO' : 'PROB30') : first;
      return {kind, prefix:change[1], body:change[2]};
    }
    return null;
  }

  function uniq(tokens) {
    return tokens.filter((t, i, a) => t && a.indexOf(t) === i);
  }

  function normalizeBody(body, ctx) {
    const original = String(body || '').replace(/=$/, '').trim().split(/\s+/).filter(Boolean);
    if (!original.length) return {body:'', drop:false};

    const highOrdinary = t => {
      const c = cloud(t);
      return !!c && !c.type && c.ft >= SIG_CLOUD_FT;
    };
    const lowOrConv = t => {
      const c = cloud(t);
      return !!c && (c.type || c.ft < SIG_CLOUD_FT);
    };

    const onlyHighClouds = original.every(highOrdinary);
    const hadHighCloud = original.some(highOrdinary);
    let tokens = original.filter(t => !highOrdinary(t));
    const hadCavok = tokens.includes('CAVOK');
    const had9999 = tokens.includes('9999');
    const hadNsw = tokens.includes('NSW');
    const hadNsc = tokens.includes('NSC');
    const hadExplicitVis = tokens.some(isVis);
    const hadMetPayload = original.some(t => isVis(t) || isWx(t) || t === 'NSW' || t === 'NSC' || t === 'CAVOK' || !!cloud(t));

    let hasSigCloud = tokens.some(lowOrConv);
    let hasWx = tokens.some(isWx);

    if (hasSigCloud) {
      if (hadCavok) {
        tokens = tokens.filter(t => t !== 'CAVOK');
        if (!tokens.some(isVis)) tokens.push('9999');
      }
      tokens = tokens.filter(t => t !== 'NSC');
    } else if (hasWx) {
      if (hadCavok) {
        tokens = tokens.filter(t => t !== 'CAVOK');
        if (!tokens.some(isVis)) tokens.unshift('9999');
      } else if (ctx.prevCavok && !tokens.some(isVis)) {
        tokens.unshift('9999');
      }
      tokens = tokens.filter(t => t !== 'NSC');
      tokens.push('NSC');
    } else {
      // CAVOK tylko przy VIS >=10 km, braku zjawisk i braku chmur istotnych.
      // Sama wysoka warstwa nie blokuje CAVOK/NSC; CB i TCU są wyjątkiem.
      const canCavok = hadCavok || had9999 ||
        (ctx.prevVis9999 && !ctx.prevWx && (hadNsw || hadNsc || hadHighCloud));
      if (canCavok && (ctx.base || hadMetPayload)) {
        tokens = tokens.filter(t => t !== 'CAVOK' && t !== '9999' && t !== 'NSW' && t !== 'NSC');
        tokens.push('CAVOK');
      } else {
        tokens = tokens.filter(t => t !== 'NSC');
        const needsNsc = ctx.base || hadNsc ||
          (hadExplicitVis && !had9999) ||
          (hadHighCloud && !ctx.prevNoSigCloud);
        if (needsNsc) tokens.push('NSC');
      }
    }

    hasSigCloud = tokens.some(lowOrConv);
    hasWx = tokens.some(isWx);
    if (tokens.includes('CAVOK') && (hasSigCloud || hasWx)) {
      tokens = tokens.filter(t => t !== 'CAVOK');
      if (!tokens.some(isVis)) tokens.unshift('9999');
      if (hasWx && !hasSigCloud && !tokens.includes('NSC')) tokens.push('NSC');
    }

    tokens = uniq(tokens);
    // Jeżeli poprzedni stan już nie zawierał chmur istotnych, grupa opisująca
    // wyłącznie zmianę wysokich zwykłych chmur nie ma znaczenia w TAF.
    const drop = !ctx.base && onlyHighClouds && ctx.prevNoSigCloud;
    return {body:tokens.join(' ').replace(/\s+/g, ' ').trim(), drop};
  }

  function updateState(state, body) {
    const next = {...state};
    const t = String(body || '').split(/\s+/).filter(Boolean);
    if (t.includes('CAVOK')) return {vis9999:true, wx:false, noSigCloud:true};

    const vis = t.find(isVis);
    if (vis) next.vis9999 = vis === '9999';
    if (t.includes('NSW')) next.wx = false;
    else if (t.some(isWx)) next.wx = true;

    const clouds = t.map(cloud).filter(Boolean);
    if (t.includes('NSC')) next.noSigCloud = true;
    else if (clouds.length) next.noSigCloud = !clouds.some(c => c.type || c.ft < SIG_CLOUD_FT);

    return next;
  }

  function normalize(raw) {
    const lines = String(raw).split(/\n+/).map(x => x.trim().replace(/=$/, '')).filter(Boolean);
    if (!lines.length) return {text:raw, removedHigh:0};

    let state = {vis9999:false, wx:false, noSigCloud:false};
    const out = [];
    let removedHigh = 0;

    for (let i = 0; i < lines.length; i++) {
      const p = splitLine(lines[i]);
      if (!p) { out.push(lines[i]); continue; }
      const before = (p.body.match(/\b(?:FEW|SCT|BKN|OVC)\d{3}(?!CB\b|TCU\b)\b/g) || [])
        .filter(t => cloud(t)?.ft >= SIG_CLOUD_FT).length;
      removedHigh += before;
      const prevCavok = state.vis9999 && !state.wx && state.noSigCloud;
      const r = normalizeBody(p.body, {
        base:p.kind === 'BASE',
        prevCavok,
        prevVis9999:state.vis9999,
        prevWx:state.wx,
        prevNoSigCloud:state.noSigCloud
      });
      if (r.drop || (!r.body && p.kind !== 'BASE')) continue;
      const line = (p.prefix + r.body).replace(/\s+/g, ' ').trim();
      out.push(line);
      if (p.kind === 'BASE' || p.kind === 'BECMG' || p.kind === 'FM') state = updateState(state, r.body);
    }

    return {text:out.join('\n') + '=', removedHigh};
  }

  function mark(removedHigh) {
    const s = $('sources');
    if (s && !s.querySelector('[data-cavok-nsc-policy]')) {
      const p = document.createElement('span');
      p.className = 'pill ok';
      p.dataset.cavokNscPolicy = '1';
      p.textContent = 'CAVOK/NSC 5000ft ✓';
      s.appendChild(p);
    }
    const box = $('reasons');
    if (box && removedHigh > 0) {
      let ul = box.querySelector('ul');
      if (!ul) { ul = document.createElement('ul'); box.appendChild(ul); }
      if (!ul.querySelector('[data-cavok-nsc-reason]')) {
        const li = document.createElement('li');
        li.dataset.cavokNscReason = '1';
        li.textContent = `Usunięto ${removedHigh} zwykłe warstwy chmur z podstawą >=5000 ft; przy braku zjawisk zastosowano CAVOK, a przy prognozowanym zjawisku i braku chmur istotnych — NSC. CB/TCU pozostają niezależnie od wysokości podstawy.`;
        ul.appendChild(li);
      }
    }
  }

  function apply() {
    if (applying) return;
    const el = $('taf');
    const current = el?.textContent?.trim() || '';
    if (!/^TAF\s+(?:AMD\s+|COR\s+)?EPIR\b/.test(current) || current === last) return;
    const r = normalize(current);
    if (!r?.text) return;
    mark(r.removedHigh);
    if (r.text === current) { last = current; return; }
    applying = true;
    el.textContent = r.text;
    last = r.text;
    applying = false;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(apply, 180);
  }

  function install() {
    const el = $('taf');
    if (!el) return;
    new MutationObserver(schedule).observe(el, {childList:true, characterData:true, subtree:true});
    schedule();
  }

  window.PrognozaEPIRTAFCavokNscPolicy = Object.freeze({normalize});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();
