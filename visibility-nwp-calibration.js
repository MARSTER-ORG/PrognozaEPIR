'use strict';
(() => {
  if (typeof window === 'undefined' || window.PrognozaEPIRVisibilityNwpCalibration) return;
  const PATH = 'data/learning/visibility-nwp-calibration.json';
  const MAX_AGE_MS = 72 * 3600e3, MIN_CASES = 40;
  const finite = Number.isFinite;
  let artifact = null, pending = null, error = null;

  function valid(config, now = Date.now()) {
    const issued = Date.parse(config?.generated_at || '');
    return config?.schema === 'prognozaepir-visibility-nwp-calibration-v1' &&
      finite(issued) && issued <= now + 60000 && now - issued <= MAX_AGE_MS &&
      config.source === 'legacy-issued-snapshots-nwp-mean-vs-epir-metar';
  }

  async function load() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetch(PATH + '?_=' + Date.now(), {cache: 'no-store'});
        if (!response.ok) throw new Error('NWP VIS calibration HTTP ' + response.status);
        const data = await response.json();
        if (!valid(data)) throw new Error('NWP VIS calibration stale or invalid');
        artifact = data;
        error = null;
      } catch (e) {
        artifact = null;
        error = String(e?.message || e);
      }
      return !!artifact;
    })();
    return pending.finally(() => { pending = null; });
  }

  // The forecast regime, never the future METAR, selects the calibration group.
  // Only good-visibility NEXT reference values change. Fog/BR classifications,
  // probability thresholds, and all low-visibility values stay untouched.
  function correct(nwpMeters, validTime, physicsMeters) {
    const v = Number(nwpMeters), point = Number(physicsMeters), t = Number(validTime);
    if (!finite(v) || !finite(point) || !finite(t) || v < 5000 || point < 5000 ||
        !valid(artifact)) return nwpMeters;
    const hr = new Date(t).getUTCHours();
    const key = (hr >= 18 || hr < 6 ? 'night_clear' : 'day_clear');
    const group = artifact.groups?.[key];
    const n = Number(group?.n), factor = Number(group?.factor);
    if (!finite(n) || n < MIN_CASES || !finite(factor)) return nwpMeters;
    return Math.max(5000, v * Math.max(0.75, Math.min(1.20, factor)));
  }

  window.PrognozaEPIRVisibilityNwpCalibration = Object.freeze({
    load, correct,
    status: () => ({ready: valid(artifact), error, windowDays: 14,
      source: artifact?.source || null, pairs: artifact?.pairs || 0,
      groups: artifact?.groups || null}),
  });
})();
