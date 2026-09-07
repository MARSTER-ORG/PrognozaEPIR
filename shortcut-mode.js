'use strict';
(() => {
  // PrognozaEPIR działa jako zwykła strona / skrót. Usuń pozostałości po wcześniejszym PWA/WebAPK.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => Promise.all(regs.map(reg => {
        const scope = reg.scope || '';
        return scope.includes('/PrognozaEPIR/') ? reg.unregister() : false;
      })))
      .catch(() => undefined);
  }
  if ('caches' in window) {
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('prognozaepir-pwa-')).map(k => caches.delete(k))))
      .catch(() => undefined);
  }

  const DESKTOP_MIN = 701;
  const byId = id => document.getElementById(id);

  function installDesktopZoomStyle() {
    if (byId('desktopZoomControlsStyle')) return;
    const style = document.createElement('style');
    style.id = 'desktopZoomControlsStyle';
    style.textContent = `
      .desktop-zoom-controls{display:none}
      @media (min-width:${DESKTOP_MIN}px){
        .desktop-zoom-controls{
          display:flex;
          align-items:center;
          justify-content:flex-end;
          gap:5px;
          width:max-content;
          max-width:100%;
          margin:0 0 6px auto;
          padding:5px 6px;
          border:1px solid var(--border);
          border-radius:7px;
          background:var(--surface);
          color:var(--ink);
          box-shadow:0 1px 2px rgba(0,0,0,.10);
        }
        .desktop-zoom-controls .desktop-zoom-title{
          color:var(--muted);
          font-size:11px;
          margin-right:3px;
          white-space:nowrap;
        }
        .desktop-zoom-controls button{
          min-width:38px;
          height:31px;
          padding:4px 9px;
          border:1px solid var(--border);
          border-radius:6px;
          background:var(--surface2);
          color:var(--ink);
          font:600 12px Arial,Helvetica,sans-serif;
          cursor:pointer;
        }
        .desktop-zoom-controls button:hover{filter:brightness(1.08)}
        .desktop-zoom-controls button:active{transform:translateY(1px)}
        .desktop-zoom-controls .desktop-zoom-value{
          min-width:58px;
          font-variant-numeric:tabular-nums;
        }
        .desktop-zoom-controls .desktop-zoom-fit{min-width:142px}
      }
    `;
    document.head.appendChild(style);
  }

  function forwardZoom(targetId) {
    const target = byId(targetId);
    if (target) target.click();
  }

  function syncDesktopZoomValue() {
    const src = byId('zoomReset');
    const dst = byId('desktopZoomValue');
    if (!dst) return;
    const txt = src?.textContent?.trim();
    dst.textContent = txt && /%/.test(txt) ? txt : '100%';
  }

  function installDesktopZoomControls() {
    if (byId('desktopZoomControls')) {
      syncDesktopZoomValue();
      return;
    }
    const wrap = document.querySelector('.wrap');
    if (!wrap) return;

    installDesktopZoomStyle();
    const bar = document.createElement('div');
    bar.id = 'desktopZoomControls';
    bar.className = 'desktop-zoom-controls';
    bar.setAttribute('aria-label', 'Sterowanie powiększeniem meteogramu na komputerze');
    bar.innerHTML =
      '<span class="desktop-zoom-title">Meteogram:</span>' +
      '<button id="desktopZoomOut" type="button" title="Pomniejsz meteogram">−</button>' +
      '<button id="desktopZoomValue" class="desktop-zoom-value" type="button" title="Przywróć skalę 100%">100%</button>' +
      '<button id="desktopZoomIn" type="button" title="Powiększ meteogram">+</button>' +
      '<button id="desktopZoomFit" class="desktop-zoom-fit" type="button" title="Dopasuj meteogram do szerokości ekranu">Dopasuj do ekranu</button>';
    wrap.parentNode.insertBefore(bar, wrap);

    byId('desktopZoomOut')?.addEventListener('click', () => {
      forwardZoom('zoomOut');
      setTimeout(syncDesktopZoomValue, 0);
    });
    byId('desktopZoomValue')?.addEventListener('click', () => {
      forwardZoom('zoomReset');
      setTimeout(syncDesktopZoomValue, 0);
    });
    byId('desktopZoomIn')?.addEventListener('click', () => {
      forwardZoom('zoomIn');
      setTimeout(syncDesktopZoomValue, 0);
    });
    byId('desktopZoomFit')?.addEventListener('click', () => {
      forwardZoom('zoomFit');
      setTimeout(syncDesktopZoomValue, 0);
    });

    const src = byId('zoomReset');
    if (src && typeof MutationObserver !== 'undefined') {
      new MutationObserver(syncDesktopZoomValue)
        .observe(src, {childList:true,characterData:true,subtree:true});
    }
    window.addEventListener('resize', () => setTimeout(syncDesktopZoomValue, 0), {passive:true});
    syncDesktopZoomValue();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installDesktopZoomControls, {once:true});
  } else {
    installDesktopZoomControls();
  }
})();
