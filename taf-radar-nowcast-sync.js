'use strict';
(() => {
  if (!/\/taf\.html$/i.test(location.pathname)) return;

  const $ = id => document.getElementById(id);
  let synced = false;
  let syncing = false;

  function radarNowcast() {
    const frame = $('tafRadarEngine');
    try {
      return frame?.contentWindow?.PrognozaEPIRRadarNowcast || null;
    } catch (_) {
      return null;
    }
  }

  function setConvectivePill(ok, detail = '') {
    const pill = $('sources')?.querySelector('[data-taf-conv]');
    if (!pill) return;
    pill.className = 'pill ' + (ok ? 'ok' : 'warn');
    pill.textContent = ok ? 'TCU/CB Radar ✓' : 'TCU/CB model fallback';
    pill.title = detail || (ok
      ? 'Radar/nowcast jest dostępny i został zsynchronizowany z bieżącym projektem TAF.'
      : 'Radar/nowcast nie jest jeszcze dostępny; używane są modele.');
  }

  function syncWhenReady() {
    const rn = radarNowcast();
    if (!rn) return;

    if (rn.error) {
      if (!synced) setConvectivePill(false, `Radar/nowcast: ${rn.error}`);
      return;
    }

    if (!rn.updatedAt) return;
    if (synced) {
      setConvectivePill(true);
      return;
    }
    if (syncing) return;

    const taf = String($('taf')?.textContent || '').trim();
    if (!/^TAF\s+EPIR\b/.test(taf)) return;

    // taf-cloud-policy tworzy znacznik fallback jeszcze przed zakończeniem
    // asynchronicznego nowcastu. Gdy radar jest już gotowy, wykonujemy jedno
    // ponowne generowanie bieżącego cyklu. Dzięki temu polityka chmur widzi
    // PrognozaEPIRRadarNowcast od początku swojego przebiegu i faktycznie
    // uwzględnia radar, zamiast tylko zmieniać kolor znacznika.
    syncing = true;
    const gen = $('gen');
    if (gen) gen.click();

    setTimeout(() => {
      const current = radarNowcast();
      const currentTaf = String($('taf')?.textContent || '').trim();
      if (current && !current.error && current.updatedAt && /^TAF\s+EPIR\b/.test(currentTaf)) {
        synced = true;
        setConvectivePill(true);
      }
      syncing = false;
    }, 2500);
  }

  function install() {
    setInterval(syncWhenReady, 750);
    syncWhenReady();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();
