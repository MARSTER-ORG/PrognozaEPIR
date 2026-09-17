'use strict';
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__PROGNOZA_EPIR_FOG_MODE_SWITCH__) return;
  window.__PROGNOZA_EPIR_FOG_MODE_SWITCH__ = true;

  const KEY = 'prognozaepir-fog-engine-mode';
  const MODE_LEGACY = 'legacy';
  const MODE_VNEXT = 'vnext';
  let legacyUi = null;

  function getMode() {
    try { return localStorage.getItem(KEY) === MODE_VNEXT ? MODE_VNEXT : MODE_LEGACY; }
    catch (_) { return MODE_LEGACY; }
  }

  function setMode(mode) {
    const next = mode === MODE_VNEXT ? MODE_VNEXT : MODE_LEGACY;
    try { localStorage.setItem(KEY, next); } catch (_) { }
    window.PrognozaEPIRFogSelectedMode = next;
    window.dispatchEvent(new CustomEvent('prognozaepir:fog-engine-mode-changed', {detail:{mode:next}}));
    location.reload();
  }

  function setEngineHeading(mode=getMode()) {
    const head = document.querySelector('#fogEngine .fog-head b');
    if (head) head.textContent = mode === MODE_VNEXT ? 'EPIR FOG ENGINE vNEXT' : 'EPIR FOG ENGINE LEGACY';
  }

  function captureLegacyUi() {
    const summary = document.getElementById('fogSummary');
    if (!summary) return;
    legacyUi = {
      summary: summary.innerHTML,
      source: document.getElementById('fogSource')?.textContent || '',
      dataNote: document.getElementById('fogDataNote')?.innerHTML || '',
      hours: document.getElementById('fogHours')?.innerHTML || '',
      diag: document.getElementById('fogDiag')?.innerHTML || '',
      stripHidden: Boolean(document.getElementById('fogStrip')?.hidden)
    };
  }

  function restoreLegacyUi() {
    if (getMode() !== MODE_LEGACY || !legacyUi) return;
    const summary = document.getElementById('fogSummary');
    if (summary) summary.innerHTML = legacyUi.summary;
    const source = document.getElementById('fogSource');
    if (source) source.textContent = 'EPIR FOG ENGINE LEGACY · poprzedni silnik';
    const note = document.getElementById('fogDataNote');
    if (note) note.innerHTML = legacyUi.dataNote;
    const hours = document.getElementById('fogHours');
    if (hours) hours.innerHTML = legacyUi.hours;
    const diag = document.getElementById('fogDiag');
    if (diag) diag.innerHTML = legacyUi.diag;
    const strip = document.getElementById('fogStrip');
    if (strip) strip.hidden = legacyUi.stripHidden;
    const nextDiag = document.getElementById('fogVNextDiagnostics');
    if (nextDiag) nextDiag.style.display = 'none';
    setEngineHeading(MODE_LEGACY);
    updateChooser();
  }

  function ensureStyle() {
    if (document.getElementById('fogModeSwitchStyle')) return;
    const s = document.createElement('style');
    s.id = 'fogModeSwitchStyle';
    s.textContent = `
      .fog-mode-switch{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:7px 0;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
      .fog-mode-copy{flex:1 1 260px;min-width:200px}.fog-mode-copy b{display:block;color:var(--blueText);font-size:11px}.fog-mode-copy span{display:block;color:var(--muted);font-size:9px;margin-top:2px;line-height:1.35}
      .fog-mode-buttons{display:flex;gap:5px;flex-wrap:wrap}.fog-mode-buttons button{border:1px solid var(--border);background:var(--surface2);color:var(--ink);border-radius:7px;padding:7px 10px;font-size:10px;font-weight:700;cursor:pointer}
      .fog-mode-buttons button.active{background:var(--blueText);border-color:var(--blueText);color:#fff}.fog-mode-badge{font-size:9px;color:var(--muted);white-space:nowrap}
      @media(max-width:700px){.fog-mode-switch{padding:7px}.fog-mode-buttons{width:100%}.fog-mode-buttons button{flex:1 1 46%;font-size:9px}.fog-mode-badge{width:100%}}
    `;
    document.head.appendChild(s);
  }

  function ensureChooser() {
    ensureStyle();
    const engine = document.getElementById('fogEngine');
    if (!engine || document.getElementById('fogEngineModeSwitch')) return false;
    const box = document.createElement('div');
    box.id = 'fogEngineModeSwitch';
    box.className = 'fog-mode-switch';
    box.innerHTML = `
      <div class="fog-mode-copy"><b>Wybór silnika mgły</b><span>LEGACY = poprzedni silnik. vNEXT = nowa fizyka SSOIL / SPBL / chłodzenie powierzchni i nowa prognoza VIS. Ten sam wybór steruje słupkami FG na meteogramie oraz generatorem TAF.</span></div>
      <div class="fog-mode-buttons">
        <button type="button" data-fog-mode="legacy">LEGACY · poprzedni</button>
        <button type="button" data-fog-mode="vnext">vNEXT · nowy</button>
      </div>
      <div id="fogModeBadge" class="fog-mode-badge"></div>`;
    engine.parentNode.insertBefore(box, engine);
    box.querySelectorAll('[data-fog-mode]').forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.fogMode)));
    updateChooser();
    return true;
  }

  function updateChooser() {
    const mode = getMode();
    window.PrognozaEPIRFogSelectedMode = mode;
    document.querySelectorAll('[data-fog-mode]').forEach(btn => {
      const active = btn.dataset.fogMode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const badge = document.getElementById('fogModeBadge');
    if (badge) badge.textContent = mode === MODE_LEGACY ? 'AKTYWNY: LEGACY' : 'AKTYWNY: vNEXT';
    setEngineHeading(mode);
    const nextDiag = document.getElementById('fogVNextDiagnostics');
    if (nextDiag && mode === MODE_VNEXT) nextDiag.style.removeProperty('display');
  }

  window.PrognozaEPIRFogMode = Object.freeze({
    key: KEY,
    get: getMode,
    set: setMode,
    LEGACY: MODE_LEGACY,
    VNEXT: MODE_VNEXT
  });
  window.PrognozaEPIRFogSelectedMode = getMode();

  window.addEventListener('prognozaepir:fog-series-updated', () => {
    queueMicrotask(() => { captureLegacyUi(); ensureChooser(); updateChooser(); });
  });
  window.addEventListener('prognozaepir:mifg-series-updated', () => {
    if (getMode() === MODE_LEGACY) setTimeout(() => { captureLegacyUi(); restoreLegacyUi(); }, 0);
  });
  window.addEventListener('prognozaepir:fog-vnext-updated', () => {
    setTimeout(() => {
      ensureChooser();
      if (getMode() === MODE_LEGACY) restoreLegacyUi();
      else updateChooser();
    }, 0);
  });

  const start = () => {
    ensureChooser();
    updateChooser();
    let tries = 0;
    const timer = setInterval(() => {
      ensureChooser();
      updateChooser();
      if (++tries > 40 || document.getElementById('fogEngineModeSwitch')) clearInterval(timer);
    }, 250);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
