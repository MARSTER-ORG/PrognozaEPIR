'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'fog-engine-v244.js'), 'utf8');

function loadEngine({ archive, fetch }) {
  const document = {};
  const window = { document, fetch };
  if (archive) window.PrognozaEPIRMessageArchive = archive;
  const context = {
    window,
    document,
    fetch,
    console: { warn() {} },
    AbortController,
    URLSearchParams,
    Date,
    Number,
    Math,
    Intl,
    Promise,
    addEventListener() {},
    dispatchEvent() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; }
  };
  vm.runInNewContext(SOURCE, context, { filename: 'fog-engine-v244.js' });
  return window.PrognozaEPIRFog244;
}

(async () => {
  const archivePayload = { schema: 'archive-primary' };
  let archiveCalls = 0;
  let fetchCalls = 0;
  const primary = loadEngine({
    archive: { latest: async force => { archiveCalls += 1; assert.strictEqual(force, true); return archivePayload; } },
    fetch: async () => { fetchCalls += 1; throw new Error('direct fetch must not run'); }
  });
  assert.strictEqual(await primary.loadObservationPayload(), archivePayload);
  assert.strictEqual(archiveCalls, 1);
  assert.strictEqual(fetchCalls, 0);

  const staticPayload = { schema: 'static-standalone' };
  let staticUrl = '';
  const standalone = loadEngine({
    fetch: async url => {
      staticUrl = String(url);
      return { ok: true, status: 200, json: async () => staticPayload };
    }
  });
  assert.strictEqual(await standalone.loadObservationPayload(), staticPayload);
  assert.match(staticUrl, /^data\/messages\/latest\.json\?_=/);

  let failedArchiveCalls = 0;
  const failed = loadEngine({
    archive: { latest: async () => { failedArchiveCalls += 1; throw new Error('all archive sources failed'); } },
    fetch: async () => ({ ok: true, status: 200, json: async () => staticPayload })
  });
  assert.strictEqual(await failed.loadObservationPayload(), staticPayload);
  assert.strictEqual(failedArchiveCalls, 1);

  console.log('FOG observation MessageArchive routing: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
