'use strict';
(() => {
  const hideUi = () => {
    // Do not remove these nodes: the legacy data loaders still update the
    // hidden source indicators after asynchronous GFS/AIFS/IMGW requests.
    const sources = document.querySelector('.sources');
    if (sources) {
      const card = sources.closest('.card');
      if (card) {
        card.style.display = 'none';
        card.setAttribute('aria-hidden', 'true');
      } else {
        sources.style.display = 'none';
      }
    }

    // Technical strips stay in DOM for older modules, but are not shown.
    for (const id of ['polradStatus','lightningStatus']) {
      const el = document.getElementById(id);
      if (el) {
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
      }
    }
  };

  hideUi();
  const observer = new MutationObserver(hideUi);
  observer.observe(document.body, {childList:true, subtree:true});
  setTimeout(() => observer.disconnect(), 10000);
})();
