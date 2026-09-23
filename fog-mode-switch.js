'use strict';
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__PROGNOZA_EPIR_FOG_MODE_SWITCH__) return;
  window.__PROGNOZA_EPIR_FOG_MODE_SWITCH__ = true;

  const KEY = 'prognozaepir-fog-engine-mode';
  const MODE_LEGACY = 'legacy';
  const MODE_VNEXT = 'vnext';

  function getMode() {
    try { return localStorage.getItem(KEY) === MODE_VNEXT ? MODE_VNEXT : MODE_LEGACY; }
    catch (_) { return MODE_LEGACY; }
  }

  function copyRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(row => {
      if (!row || typeof row !== 'object') return row;
      const out = {...row};
      if (Array.isArray(row.models)) {
        out.models = row.models.map(model => {
          if (!model || typeof model !== 'object') return model;
          return {
            ...model,
            components: model.components && typeof model.components === 'object'
              ? {...model.components}
              : model.components
          };
        });
      }
      if (row.vnext && typeof row.vnext === 'object') out.vnext = {...row.vnext};
      if (row.vnextProbability && typeof row.vnextProbability === 'object') out.vnextProbability = {...row.vnextProbability};
      if (row.visGuidance && typeof row.visGuidance === 'object') out.visGuidance = {...row.visGuidance};
      return out;
    });
  }

  function setMode(mode) {
    const next = mode === MODE_VNEXT ? MODE_VNEXT : MODE_LEGACY;
    try { localStorage.setItem(KEY, next); } catch (_) {}
    window.PrognozaEPIRFogSelectedMode = next;
    try {
      window.dispatchEvent(new CustomEvent('prognozaepir:fog-engine-mode-changed', {detail:{mode:next}}));
    } catch (_) {}
    location.reload();
  }

  function installApi() {
    window.PrognozaEPIRFogMode = Object.freeze({
      key: KEY,
      get: getMode,
      set: setMode,
      LEGACY: MODE_LEGACY,
      VNEXT: MODE_VNEXT
    });
  }

  function ensureStyle() {
    if (document.getElementById('fogModeSwitchStyle')) return;
    const style = document.createElement('style');
    style.id = 'fogModeSwitchStyle';
    style.textContent = `
      html[data-epir-fog-mode] body #fogEngineModeSwitch{display:flex!important}
      html[data-epir-fog-mode="legacy"] body #fogEngine{display:block!important}
      html[data-epir-fog-mode="legacy"] body #fogEngine244{display:none!important}
      html[data-epir-fog-mode="vnext"] body #fogEngine{display:none!important}
      html[data-epir-fog-mode="vnext"] body #fogEngine244{display:block!important}
      .fog-mode-switch{align-items:center;gap:7px;flex-wrap:wrap;margin:7px 0;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
      .fog-mode-copy{flex:1 1 280px;min-width:210px}
      .fog-mode-copy b{display:block;color:var(--blueText);font-size:11px}
      .fog-mode-copy span{display:block;color:var(--muted);font-size:9px;margin-top:2px;line-height:1.35}
      .fog-mode-buttons{display:flex;gap:5px;flex-wrap:wrap}
      .fog-mode-buttons button{border:1px solid var(--border);background:var(--surface2);color:var(--ink);border-radius:7px;padding:7px 10px;font-size:10px;font-weight:700;cursor:pointer}
      .fog-mode-buttons button.active{background:var(--blueText);border-color:var(--blueText);color:#fff}
      .fog-mode-badge{font-size:9px;font-weight:700;color:var(--muted);white-space:nowrap}
      @media(max-width:700px){.fog-mode-switch{padding:7px}.fog-mode-buttons{width:100%}.fog-mode-buttons button{flex:1 1 46%;font-size:9px}.fog-mode-badge{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensureChooser() {
    ensureStyle();
    if (document.getElementById('fogEngineModeSwitch')) return true;
    const engine = document.getElementById('fogEngine');
    const nextEngine = document.getElementById('fogEngine244');
    const mount = document.getElementById('fogStandaloneMount') || document.querySelector('.app') || document.body;
    if (!mount) return false;

    const box = document.createElement('div');
    box.id = 'fogEngineModeSwitch';
    box.className = 'fog-mode-switch';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Wybór aktywnego silnika mgły');
    box.innerHTML = `
      <div class="fog-mode-copy">
        <b>Aktywny silnik mgły</b>
        <span>LEGACY = poprzedni silnik. NEXT 2.4.4 = zintegrowany nowy silnik. Ten sam wybór obowiązuje na meteogramie i w generatorze TAF.</span>
      </div>
      <div class="fog-mode-buttons">
        <button type="button" data-fog-mode="legacy">LEGACY</button>
        <button type="button" data-fog-mode="vnext">NEXT · 2.4.4</button>
      </div>
      <div id="fogModeBadge" class="fog-mode-badge" aria-live="polite"></div>`;

    if (engine?.parentNode) engine.parentNode.insertBefore(box, engine);
    else if (nextEngine?.parentNode) nextEngine.parentNode.insertBefore(box, nextEngine);
    else mount.prepend(box);

    box.querySelectorAll('[data-fog-mode]').forEach(button => {
      button.addEventListener('click', () => setMode(button.dataset.fogMode));
    });
    return true;
  }

  function applyPanelVisibility() {
    document.documentElement.setAttribute('data-epir-fog-mode', getMode());
  }

  function updateChooser() {
    const mode = getMode();
    document.querySelectorAll('[data-fog-mode]').forEach(button => {
      const active = button.dataset.fogMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const badge = document.getElementById('fogModeBadge');
    if (badge) badge.textContent = mode === MODE_LEGACY ? 'AKTYWNY: LEGACY' : 'AKTYWNY: NEXT 2.4.4';
  }

  function applySelectedSeries() {
    const mode = getMode();
    const legacy = copyRows(window.PrognozaEPIRFogLegacySeries);
    const vnext = copyRows(window.PrognozaEPIRFogVNextSeries);
    const selected = mode === MODE_VNEXT ? vnext : legacy;

    if (selected.length) {
      window.PrognozaEPIRFogSeries = selected;
      window.PrognozaEPIRFogRenderSeries = copyRows(selected);
    }
    window.PrognozaEPIRFogSelectedMode = mode;
    window.PrognozaEPIRFogEngineMode = mode === MODE_VNEXT ? 'vnext-production-2.4.4' : 'legacy';

    installApi();
    applyPanelVisibility();
    ensureChooser();
    updateChooser();
  }

  const reapply = () => setTimeout(applySelectedSeries, 0);
  for (const eventName of [
    'prognozaepir:fog-series-updated',
    'prognozaepir:fog-vnext-updated',
    'prognozaepir:fog-engine-mode-applied'
  ]) {
    window.addEventListener(eventName, reapply);
  }

  const start = () => {
    installApi();
    applyPanelVisibility();
    ensureChooser();
    applySelectedSeries();

    let tries = 0;
    const timer = setInterval(() => {
      ensureChooser();
      applySelectedSeries();
      if (++tries > 40 || (document.getElementById('fogEngineModeSwitch') && document.getElementById('fogEngine244'))) {
        clearInterval(timer);
      }
    }, 250);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
