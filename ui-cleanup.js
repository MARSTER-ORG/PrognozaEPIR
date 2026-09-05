'use strict';
(() => {
  const removeUi = () => {
    // Remove the whole Sources/Status card, not only its rows.
    const sources = document.querySelector('.sources');
    if (sources) {
      const card = sources.closest('.card');
      if (card) card.remove(); else sources.remove();
    }
    // Remove technical status strips under the map.
    document.getElementById('polradStatus')?.remove();
    document.getElementById('lightningStatus')?.remove();
  };

  removeUi();
  // Some older modules create these elements after startup. Keep the UI clean
  // without changing the data-loading logic behind them.
  const observer = new MutationObserver(removeUi);
  observer.observe(document.body,{childList:true,subtree:true});
  setTimeout(()=>observer.disconnect(),5000);
})();
