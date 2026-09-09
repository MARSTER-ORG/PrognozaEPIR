'use strict';

// EUMETSAT MTG Lightning Imager LI AFA layer disabled.
// Intentionally left as a no-op compatibility stub so the existing Pages
// build can keep referencing this asset without rendering or using LI data.
(() => {
  try {
    delete window.PrognozaEPIRLightning;
  } catch (_) {
    window.PrognozaEPIRLightning = undefined;
  }
  for (const id of ['lightningToggle','lightningStatus','srcLightningLive']) {
    document.getElementById(id)?.remove();
  }
})();
