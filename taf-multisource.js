'use strict';
/* Compatibility name retained after central archive cutover. */
(() => {
  if(window.PrognozaEPIRTAFSources) return;
  const s=document.createElement('script');
  s.src='taf-archive-source.js';
  s.async=false;
  document.head.appendChild(s);
})();
