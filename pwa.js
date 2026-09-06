'use strict';
(() => {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  document.documentElement.classList.toggle('pwa-standalone', standalone);

  window.addEventListener('appinstalled', () => {
    try { localStorage.setItem('prognozaepir-installed-at', new Date().toISOString()); } catch (_) {}
  });

  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js?v=2', { scope: './', updateViaCache: 'none' })
      .then(reg => reg.update())
      .catch(err => console.warn('PrognozaEPIR PWA service worker:', err));
  });
})();
