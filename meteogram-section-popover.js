'use strict';
(() => {
  const POPOVER_ID = 'meteogramSectionPopover';
  const CONTENT_ID = 'meteogramSectionPopoverContent';
  const STYLE_ID = 'meteogramSectionPopoverStyle';
  let lastPoint = {x: Math.max(16, window.innerWidth / 2), y: Math.max(16, window.innerHeight / 2)};
  let boundCanvas = null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function getCanvas() {
    try {
      if (typeof cv !== 'undefined' && cv && cv.tagName === 'CANVAS') return cv;
    } catch (_) {}
    return document.querySelector('#meteogram canvas, canvas#meteogram, .meteogram canvas, canvas');
  }

  function getSource() {
    return document.getElementById('sectionInfo');
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #sectionInfo.epir-section-info-source-hidden {
        display: none !important;
      }
      #${POPOVER_ID} {
        position: fixed;
        z-index: 2147483000;
        width: min(460px, calc(100vw - 16px));
        max-height: min(62vh, 560px);
        overflow: auto;
        box-sizing: border-box;
        padding: 12px 12px 11px;
        border: 1px solid var(--border, #59616b);
        border-radius: 10px;
        background: var(--panel, #20262c);
        color: var(--text, #e5e7eb);
        box-shadow: 0 10px 34px rgba(0,0,0,.48);
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
      }
      #${POPOVER_ID}[hidden] { display: none !important; }
      #${POPOVER_ID} .epir-popover-close {
        position: sticky;
        z-index: 2;
        top: 0;
        float: right;
        width: 30px;
        height: 30px;
        margin: -5px -5px 3px 8px;
        border: 1px solid var(--border, #59616b);
        border-radius: 7px;
        background: var(--panel2, #2a3037);
        color: var(--text, #e5e7eb);
        font: 700 20px/26px Arial,sans-serif;
        text-align: center;
        cursor: pointer;
      }
      #${POPOVER_ID} .section-head {
        padding-right: 32px;
      }
      #${POPOVER_ID} .section-values {
        grid-template-columns: repeat(2, minmax(0,1fr)) !important;
      }
      #${POPOVER_ID} .section-help {
        margin-bottom: 0;
      }
      @media (max-width: 560px) {
        #${POPOVER_ID} {
          width: calc(100vw - 14px);
          max-height: 58vh;
          padding: 10px;
          border-radius: 9px;
        }
        #${POPOVER_ID} .section-values {
          grid-template-columns: repeat(2, minmax(0,1fr)) !important;
          gap: 6px !important;
        }
      }
      @media (max-width: 360px) {
        #${POPOVER_ID} .section-values {
          grid-template-columns: 1fr !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function ensurePopover() {
    installStyle();
    let pop = document.getElementById(POPOVER_ID);
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = POPOVER_ID;
    pop.hidden = true;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Parametry wybranej sekcji meteogramu');
    pop.innerHTML = '<button type="button" class="epir-popover-close" aria-label="Zamknij">×</button><div id="'+CONTENT_ID+'"></div>';
    pop.querySelector('.epir-popover-close').addEventListener('click', () => { pop.hidden = true; });
    document.body.appendChild(pop);
    return pop;
  }

  function hideLegacyPanel() {
    const source = getSource();
    if (!source) return;
    source.classList.add('epir-section-info-source-hidden');
    source.setAttribute('aria-hidden', 'true');
  }

  function rememberPointer(ev) {
    const p = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
    if (!p || !Number.isFinite(Number(p.clientX)) || !Number.isFinite(Number(p.clientY))) return;
    lastPoint = {x: Number(p.clientX), y: Number(p.clientY)};
  }

  function positionPopover() {
    const pop = document.getElementById(POPOVER_ID);
    if (!pop || pop.hidden) return;
    const margin = 7;
    const gap = 14;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;

    pop.style.visibility = 'hidden';
    pop.style.left = margin + 'px';
    pop.style.top = margin + 'px';
    const rect = pop.getBoundingClientRect();

    let left = lastPoint.x + gap;
    if (left + rect.width > vw - margin) left = lastPoint.x - rect.width - gap;
    left = clamp(left, margin, Math.max(margin, vw - rect.width - margin));

    let top = lastPoint.y - rect.height - gap;
    if (top < margin) top = lastPoint.y + gap;
    top = clamp(top, margin, Math.max(margin, vh - rect.height - margin));

    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
    pop.style.visibility = 'visible';
  }

  function syncPopover() {
    const source = getSource();
    if (!source) return;
    hideLegacyPanel();
    const html = String(source.innerHTML || '').trim();
    if (!html) return;

    const pop = ensurePopover();
    const content = document.getElementById(CONTENT_ID);
    if (!content) return;
    content.innerHTML = html;
    pop.hidden = false;
    requestAnimationFrame(positionPopover);
  }

  function bindCanvas() {
    const canvas = getCanvas();
    if (!canvas || canvas === boundCanvas) return;
    if (boundCanvas) {
      boundCanvas.removeEventListener('pointerdown', rememberPointer, true);
      boundCanvas.removeEventListener('touchstart', rememberPointer, true);
    }
    boundCanvas = canvas;
    canvas.addEventListener('pointerdown', rememberPointer, {capture:true, passive:true});
    canvas.addEventListener('touchstart', rememberPointer, {capture:true, passive:true});
  }

  function wrapShowSectionInfo() {
    if (typeof window.showSectionInfo !== 'function') return false;
    if (window.showSectionInfo.__epirSectionPopoverWrapped) return true;
    const base = window.showSectionInfo;
    const wrapped = function() {
      const result = base.apply(this, arguments);
      syncPopover();
      queueMicrotask(syncPopover);
      requestAnimationFrame(syncPopover);
      return result;
    };
    wrapped.__epirSectionPopoverWrapped = true;
    wrapped.__epirSectionPopoverBase = base;
    window.showSectionInfo = wrapped;
    return true;
  }

  function install() {
    ensurePopover();
    hideLegacyPanel();
    bindCanvas();
    wrapShowSectionInfo();
  }

  document.addEventListener('click', ev => {
    const pop = document.getElementById(POPOVER_ID);
    if (!pop || pop.hidden) return;
    const canvas = getCanvas();
    if (pop.contains(ev.target) || (canvas && canvas.contains(ev.target))) return;
    pop.hidden = true;
  });

  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    const pop = document.getElementById(POPOVER_ID);
    if (pop) pop.hidden = true;
  });

  window.addEventListener('resize', () => requestAnimationFrame(positionPopover), {passive:true});
  window.addEventListener('scroll', () => requestAnimationFrame(positionPopover), {passive:true});

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();

  // Other meteogram modules can wrap showSectionInfo during startup. Re-wrap only when needed.
  setTimeout(install, 250);
  setTimeout(install, 1200);
  setInterval(() => { hideLegacyPanel(); bindCanvas(); wrapShowSectionInfo(); }, 10000);
})();
