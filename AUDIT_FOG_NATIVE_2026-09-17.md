# EPIR FOG — audit runtime 2026-09-17

## Root cause

The standalone fog page had been replaced by a hidden `index.html` iframe. The page then moved Fog Engine DOM nodes out of the meteogram layout and hid the original meteogram container. That architecture made the page dependent on the full meteogram runtime, duplicated navigation/layout responsibilities, and allowed Fog Engine panels to disappear when iframe DOM timing changed.

## Corrected architecture

`fog.html` is again a native standalone page. It has no iframe, canvas, meteogram container, MutationObserver or ResizeObserver. It loads only the Fog runtime modules required for mode selection, FG, BR, MIFG, vNEXT enrichment, standalone ordering and visibility cells.

The page owns a static top navigation and a single `#fogStandaloneMount`. The build treats any reintroduction of `index.html?fogpanel=`, `<iframe>`, `fogRuntime`, canvas or meteogram-only scripts as an error.

## TAF contract

TAF reads `PrognozaEPIRTAFFogPolicy.selectedMode(window)` and then `seriesForMode(window, mode)`. LEGACY uses the dedicated `PrognozaEPIRFogLegacySeries` snapshot; vNEXT uses the vNEXT series. No cross-mode fallback is permitted by the integration test.

## FG / BR / MIFG cells

The three visibility/context cards remain present even when no event is active. Inactive state is rendered as `—` plus a short no-event message rather than deleting the card from the DOM.

## Removed obsolete automation

Three old one-shot patch workflows were removed because their changes are now permanent in source/build code and they encoded older Fog page contracts:

- `one-shot-epir-fog-ui.yml`
- `one-shot-fog-deploy-fix.yml`
- `one-shot-br-meteogram-date-sync.yml`
