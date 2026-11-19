'use strict';

// Execute the production loader (not a duplicate implementation) with mocked
// provider requests. A failed DMI response must never suppress KNMI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'fog-engine.js'), 'utf8');
const start = source.indexOf('  async function refreshExternal(){');
const end = source.indexOf('\n  function rawSurface(', start);
assert(start >= 0 && end > start, 'Fog LEGACY loader not found');
const loader = source.slice(start, end);

async function scenario({ dmiFails, knmiFails }) {
  const calls = { dmi: 0, knmi: 0, rebuilds: 0, delays: [] };
  const sandbox = {
    Date, Promise, MODELS: [], CORE_SUPPLEMENT_MODELS: new Set(), window: {},
    console: { warn() {} },
    setTimeout(fn, delay) { calls.delays.push(delay); return calls.delays.length; },
    clearTimeout() {},
    async fetchDmi() {
      calls.dmi++;
      if (dmiFails) throw new Error('DMI HTTP 503');
      sandbox.dmiRows = Array.from({ length: 24 }, (_, i) => ({ t: i }));
    },
    async fetchKnmi() {
      calls.knmi++;
      if (knmiFails) throw new Error('KNMI HTTP 503');
      sandbox.knmiRows = Array.from({ length: 24 }, (_, i) => ({ t: i }));
    },
    async fetchSupplement() {},
    async fetchAdaptiveWeights() {},
    async fetchFogEventSkill() {},
    async fetchArchiveObservation() {},
    rebuildEngine() {
      calls.rebuilds++;
      const hasSource = sandbox.dmiRows.length > 10 || sandbox.knmiRows.length > 10;
      sandbox.window.PrognozaEPIRFogLegacySeries = hasSource
        ? Array.from({ length: 24 }, (_, i) => ({ t: i, score: 20 })) : [];
    }
  };
  await vm.runInNewContext(
    'var fetchBusy=false, engineError="", recoveryAttempt=0, recoveryTimer=null;\n' +
    'var dmiRows=[], knmiRows=[];\n' +
    'const RECOVERY_DELAYS_MS=[10000,30000,60000];\n' +
    loader + '\nrefreshExternal();',
    sandbox, { timeout: 5000 }
  );
  return { calls, status: sandbox.window.PrognozaEPIRFogLegacySourceStatus };
}

(async () => {
  const knmiOnly = await scenario({ dmiFails: true, knmiFails: false });
  assert.equal(knmiOnly.calls.dmi, 1);
  assert.equal(knmiOnly.calls.knmi, 1);
  assert.equal(knmiOnly.status.ready, true, 'KNMI must independently keep LEGACY ready');
  assert.equal(knmiOnly.status.knmiRows, 24);
  assert.deepEqual(knmiOnly.calls.delays, [], 'do not retry when a real provider is ready');

  const dmiOnly = await scenario({ dmiFails: false, knmiFails: true });
  assert.equal(dmiOnly.status.ready, true, 'DMI must independently keep LEGACY ready');
  assert.equal(dmiOnly.status.dmiRows, 24);

  const unavailable = await scenario({ dmiFails: true, knmiFails: true });
  assert.equal(unavailable.status.ready, false, 'never synthesize fog series with no NWP source');
  assert.equal(unavailable.calls.rebuilds, 1);
  assert.deepEqual(unavailable.calls.delays, [10000], 'schedule a bounded early recovery');
  assert.equal(unavailable.status.errors.length, 2);
  console.log('Fog LEGACY independent-source and unavailable/retry regression: OK');
})().catch(err => { console.error(err); process.exitCode = 1; });
