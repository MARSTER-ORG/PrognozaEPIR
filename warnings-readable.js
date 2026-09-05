'use strict';

// Convert IMGW TERYT county codes into readable warning areas.
(() => {
  const VOIVODESHIPS = {
    '02':'dolnośląskie','04':'kujawsko-pomorskie','06':'lubelskie','08':'lubuskie',
    '10':'łódzkie','12':'małopolskie','14':'mazowieckie','16':'opolskie',
    '18':'podkarpackie','20':'podlaskie','22':'pomorskie','24':'śląskie',
    '26':'świętokrzyskie','28':'warmińsko-mazurskie','30':'wielkopolskie','32':'zachodniopomorskie'
  };

  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
  const countyWord = n => n === 1 ? 'powiat' : (
    n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'powiaty' : 'powiatów'
  );
  const fmtDate = value => {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[3]}.${m[2]} ${m[4]}:${m[5]}` : String(value || '—');
  };
  const areaLabel = warning => {
    const codes = Array.isArray(warning?.teryt) ? warning.teryt : [];
    const counts = new Map();
    for (const raw of codes) {
      const code = String(raw).padStart(4, '0');
      const prefix = code.slice(0, 2);
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
    const parts = [...counts.entries()].map(([prefix, count]) => {
      const name = VOIVODESHIPS[prefix] || `woj. ${prefix}`;
      return `${name} — ${count} ${countyWord(count)}`;
    });
    return parts.length ? parts.join('; ') : 'obszar nieopisany w odpowiedzi IMGW';
  };

  if (!el('warnReadableStyle')) {
    const style = document.createElement('style');
    style.id = 'warnReadableStyle';
    style.textContent = [
      '.warn-area{margin:4px 0 3px;line-height:1.45}',
      '.warn-area b,.warn-time b{color:var(--muted)}',
      '.warn-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:3px;color:var(--muted)}'
    ].join('');
    document.head.appendChild(style);
  }

  window.loadWarnings = async function loadWarningsReadable() {
    try {
      const response = await fetch('https://danepubliczne.imgw.pl/api/data/warningsmeteo', {cache:'no-cache'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const warnings = await response.json();
      const dot = el('srcImgw');
      if (dot) dot.className = 'dot ok';
      const box = el('warnings');
      if (!box) return;

      if (!Array.isArray(warnings) || !warnings.length) {
        box.textContent = 'Brak aktywnych ostrzeżeń w odpowiedzi API IMGW.';
        return;
      }

      const nearDefault = typeof point !== 'undefined' && typeof DEFAULT !== 'undefined' &&
        Math.hypot(point.lat - DEFAULT.lat, point.lon - DEFAULT.lon) < .01;
      let list = warnings;

      // Inowrocław/default point belongs to woj. kujawsko-pomorskie (TERYT prefix 04).
      if (nearDefault) {
        list = warnings.filter(w => Array.isArray(w?.teryt) &&
          w.teryt.some(code => String(code).padStart(4, '0').startsWith('04')));
        if (!list.length) {
          box.innerHTML = 'Brak aktywnych ostrzeżeń dla woj. kujawsko-pomorskiego. <span style="color:var(--muted)">API IMGW jest aktywne.</span>';
          return;
        }
      }

      list = list.slice().sort((a, b) => Number(b.stopien || 0) - Number(a.stopien || 0)).slice(0, 6);
      box.innerHTML = list.map(w => {
        const event = esc(w.nazwa_zdarzenia || w.zdarzenie || w.event || w.nazwa || 'Ostrzeżenie meteorologiczne');
        const level = esc(w.stopien || w.stopien_zagrozenia || w.level || '');
        const probability = esc(w.prawdopodobienstwo || '');
        const area = esc(areaLabel(w));
        const from = esc(fmtDate(w.obowiazuje_od || w.od || w.start));
        const to = esc(fmtDate(w.obowiazuje_do || w.do || w.end));
        return `<div class="warn"><strong>${event}${level ? ' · stopień ' + level : ''}</strong>` +
          `<div class="warn-area"><b>Obszar:</b> ${area}</div>` +
          `<div class="warn-meta">${probability ? `<span><b>Prawdopodobieństwo:</b> ${probability}%</span>` : ''}` +
          `<span class="warn-time"><b>Ważne:</b> ${from} → ${to}</span></div></div>`;
      }).join('');
    } catch (_) {
      const dot = el('srcImgw');
      if (dot) dot.className = 'dot bad';
      const box = el('warnings');
      if (box) box.textContent = 'Nie udało się pobrać ostrzeżeń IMGW.';
    }
  };

  // Re-render immediately because radar.html starts its first refresh before this extension loads.
  window.loadWarnings();
})();
