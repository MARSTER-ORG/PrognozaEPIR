'use strict';
(() => {
  if (window.__PROGNOZA_EPIR_GLOBAL_THEME__) return;
  window.__PROGNOZA_EPIR_GLOBAL_THEME__ = true;

  const STORAGE_KEY = 'prognozaepir.theme.preference';
  const ALLOWED = new Set(['system', 'light', 'dark']);
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function readPreference() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return ALLOWED.has(value) ? value : 'system';
    } catch (_) {
      return 'system';
    }
  }

  let preference = readPreference();

  function resolvedTheme() {
    if (preference === 'light' || preference === 'dark') return preference;
    return media && media.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const theme = resolvedTheme();
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    root.style.colorScheme = theme;
    const select = document.getElementById('prognozaepir-theme-select');
    if (select && select.value !== preference) select.value = preference;
    return theme;
  }

  function setPreference(value) {
    preference = ALLOWED.has(value) ? value : 'system';
    try { localStorage.setItem(STORAGE_KEY, preference); } catch (_) {}
    const theme = applyTheme();
    try {
      window.dispatchEvent(new CustomEvent('prognozaepir:themechange', { detail: { preference, theme } }));
    } catch (_) {}
  }

  const css = `
html[data-theme="light"]{
  --bg:#f4f6f8!important;--ink:#17242d!important;--text:#17242d!important;
  --muted:#586c79!important;--line:#b7c6cf!important;--border:#b7c6cf!important;
  --panel:#ffffff!important;--panel2:#f5f8fa!important;--surface:#ffffff!important;
  --surface2:#f5f8fa!important;--soft:#f1f5f7!important;--accent:#0b6098!important;
  --blue:#263e9b!important;--blue2:#263e9b!important;--blueText:#263e78!important;
  --ok:#176b3a!important;--green:#176b3a!important;--warn:#815700!important;
  --orange:#9a520f!important;--bad:#aa281f!important;--red:#b52b23!important;
  color-scheme:light!important;
}
html[data-theme="dark"]{color-scheme:dark!important;}
html[data-theme="light"] body{background:#f4f6f8!important;color:#17242d!important;}
html[data-theme="light"] .card,
html[data-theme="light"] .panel,
html[data-theme="light"] .toolbar,
html[data-theme="light"] .section-info,
html[data-theme="light"] .metric,
html[data-theme="light"] .stat,
html[data-theme="light"] .empty{background:#ffffff!important;color:#17242d!important;border-color:#b7c6cf!important;}
html[data-theme="light"] .taf{
  background:#ffffff!important;color:#07131c!important;border-color:#7895a7!important;
  box-shadow:inset 0 0 0 1px rgba(25,66,91,.05),0 1px 4px rgba(20,47,65,.10)!important;
}
html[data-theme="light"] .raw,
html[data-theme="light"] pre.raw{background:#f7fafc!important;color:#10212c!important;border-color:#9db3c1!important;}
html[data-theme="light"] .badge,
html[data-theme="light"] .pill{background:#edf4f7!important;color:#263d4b!important;border-color:#b3c5cf!important;}
html[data-theme="light"] .badge.ok,
html[data-theme="light"] .pill.ok,
html[data-theme="light"] .ok{color:#176b3a!important;}
html[data-theme="light"] .warn{color:#815700!important;}
html[data-theme="light"] .bad{color:#aa281f!important;}
html[data-theme="light"] input,
html[data-theme="light"] select,
html[data-theme="light"] textarea{background:#ffffff!important;color:#17242d!important;border-color:#9fb3c0!important;}
html[data-theme="light"] option{background:#ffffff!important;color:#17242d!important;}
html[data-theme="light"] .checklist li{background:#f6f9fb!important;color:#17242d!important;border-color:#b8c8d1!important;}
html[data-theme="light"] .tablewrap,
html[data-theme="light"] .table-wrap{border-color:#b8c8d1!important;background:#ffffff!important;}
html[data-theme="light"] table{background:#ffffff!important;color:#17242d!important;}
html[data-theme="light"] th{background:#eaf1f5!important;color:#243d4b!important;border-color:#c0ced6!important;}
html[data-theme="light"] td{border-color:#d2dde3!important;color:#17242d!important;}
html[data-theme="light"] h2,
html[data-theme="light"] h3{color:#203946!important;}
html[data-theme="light"] .muted,
html[data-theme="light"] .note,
html[data-theme="light"] .statusline,
html[data-theme="light"] .footer{color:#586c79!important;}
html[data-theme="light"] .note{border-left-color:#6f94a8!important;}
html[data-theme="light"] a{color:#0b6098;}
html[data-theme="light"] .controls select{background:#ffffff!important;color:#17242d!important;border-color:#9fb3c0!important;}
html[data-theme="light"] .legend-dbz{background:rgba(255,255,255,.94)!important;color:#222!important;}
#themeToggle{display:none!important;}
#prognozaepir-theme-control{
  position:fixed;left:max(8px,env(safe-area-inset-left));bottom:max(8px,env(safe-area-inset-bottom));
  z-index:2147483000;display:flex;align-items:center;gap:6px;padding:5px 7px;
  border:1px solid rgba(130,150,164,.75);border-radius:9px;background:rgba(250,252,253,.94);
  color:#20313c;box-shadow:0 2px 10px rgba(0,0,0,.14);backdrop-filter:blur(8px);
  font:600 11px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
}
html[data-theme="dark"] #prognozaepir-theme-control{background:rgba(18,24,29,.94);color:#e4edf2;border-color:#52616b;box-shadow:0 2px 12px rgba(0,0,0,.35);}
#prognozaepir-theme-control label{display:flex;align-items:center;gap:5px;color:inherit!important;}
#prognozaepir-theme-select{
  appearance:auto;min-width:94px;padding:4px 6px;border:1px solid #9fb1bc;border-radius:6px;
  background:#fff;color:#17242d;font:600 11px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
}
html[data-theme="dark"] #prognozaepir-theme-select{background:#202a31;color:#edf3f6;border-color:#596a75;}
#prognozaepir-theme-select:focus-visible{outline:2px solid #3c82b1;outline-offset:2px;}
@media(max-width:600px){
  #prognozaepir-theme-control{left:max(5px,env(safe-area-inset-left));bottom:max(5px,env(safe-area-inset-bottom));padding:4px 5px;font-size:10px;}
  #prognozaepir-theme-select{min-width:86px;font-size:10px;padding:4px 5px;}
}
@media print{#prognozaepir-theme-control{display:none!important;}}
`;

  function installStyle() {
    if (document.getElementById('prognozaepir-theme-style')) return;
    const style = document.createElement('style');
    style.id = 'prognozaepir-theme-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function mountControl() {
    if (!document.body || document.getElementById('prognozaepir-theme-control')) return;
    const host = document.createElement('div');
    host.id = 'prognozaepir-theme-control';
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Tryb kolorystyczny strony');
    host.innerHTML = '<label for="prognozaepir-theme-select">Motyw <select id="prognozaepir-theme-select" aria-label="Motyw strony"><option value="system">Systemowy</option><option value="light">Jasny</option><option value="dark">Ciemny</option></select></label>';
    document.body.appendChild(host);
    const select = host.querySelector('select');
    select.value = preference;
    select.addEventListener('change', () => setPreference(select.value));
  }

  installStyle();
  applyTheme();
  if (media) {
    const onSystemChange = () => { if (preference === 'system') applyTheme(); };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemChange);
    else if (typeof media.addListener === 'function') media.addListener(onSystemChange);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountControl, { once: true });
  else mountControl();

  window.PrognozaEPIRTheme = Object.freeze({
    getPreference: () => preference,
    getResolved: resolvedTheme,
    setPreference
  });
})();
