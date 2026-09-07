'use strict';
(() => {
  const DESKTOP_MIN = 701;

  function byId(id) { return document.getElementById(id); }

  function installStyle() {
    if (document.getElementById('desktopZoomControlsStyle')) return;
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
          margin:0 0 6px;
          padding:5px 6px;
          border:1px solid var(--border);
          border-radius:7px;
          background:var(--surface);
          color:var(--ink);
          width:max-content;
          max-width:100%;
          margin-left:auto;
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
        .desktop-zoom-controls .desktop-zoom-fit{
          min-width:142px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function forward(targetId) {
    const target = byId(targetId);
    if (target) target.click();
  }

  function syncValue() {
    const src = byId('zoomReset');
    const dst = byId('desktopZoomValue');
    if (!dst) return;
    const txt = src?.textContent?.trim();
    dst.textContent = txt && /%/.test(txt) ? txt : '100%';
  }

  function install() {
    if (byId('desktopZoomControls')) {
      syncValue();
      return;
    }
    const wrap = document.querySelector('.wrap');
    if (!wrap) return;

    installStyle();

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

    byId('desktopZoomOut')?.addEventListener('click', () => { forward('zoomOut'); setTimeout(syncValue, 0); });
    byId('desktopZoomValue')?.addEventListener('click', () => { forward('zoomReset'); setTimeout(syncValue, 0); });
    byId('desktopZoomIn')?.addEventListener('click', () => { forward('zoomIn'); setTimeout(syncValue, 0); });
    byId('desktopZoomFit')?.addEventListener('click', () => { forward('zoomFit'); setTimeout(syncValue, 0); });

    const src = byId('zoomReset');
    if (src && typeof MutationObserver !== 'undefined') {
      new MutationObserver(syncValue).observe(src, {childList:true,characterData:true,subtree:true});
    }
    window.addEventListener('resize', () => setTimeout(syncValue, 0), {passive:true});
    syncValue();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, {once:true});
  } else {
    install();
  }
})();
