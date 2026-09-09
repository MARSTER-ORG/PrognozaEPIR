'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const guard = require('../taf-instruction-guard.js');

const NOW = Date.UTC(2026, 8, 9, 5, 0, 0);
const base = body => `TAF EPIR 090500Z 0906/0918 ${body}=`;
const norm = (raw, extra = {}) => guard.normalize(raw, {now: NOW, series: [], ...extra}).text;

// Instrukcja 11.2023: CAVOK i NSC mają dwa odrębne progi zapisane w różnych jednostkach.
assert.equal(guard.constants.CAVOK_BASE_LIMIT_M, 1500);
assert.ok(Math.abs(guard.constants.CAVOK_BASE_LIMIT_FT - 4921.26) < 0.1);
assert.equal(guard.constants.NSC_LIMIT_FT, 5000);
assert.notEqual(guard.constants.NSC_LIMIT_FT, guard.constants.CAVOK_BASE_LIMIT_FT);

// Granica 1500 m dla CAVOK: BKN049 blokuje, BKN050 już nie blokuje przy MSA <= 5000 ft.
assert.match(norm(base('18005KT 9999 BKN049')), /9999 BKN049=$/);
assert.match(norm(base('18005KT 9999 BKN050')), /18005KT CAVOK=$/);

// NSC: przy widzialności <10 km zwykła warstwa na 5000 ft nie jest już kodowana.
assert.match(norm(base('18005KT 3000 BKN050')), /18005KT 3000 NSC=$/);

// Jeżeli MSA jest wyższa, oba progi operacyjne muszą zostać podniesione do MSA.
assert.match(norm(base('18005KT 9999 BKN050'), {msaFt: 6000}), /9999 BKN050=$/);

// Normalizacja musi być idempotentna — ponowne przejście nie może przełączać CAVOK/NSC.
for (const raw of [
  base('18005KT 9999 BKN049'),
  base('18005KT 9999 BKN050'),
  base('18005KT 3000 BKN050'),
  base('18005KT CAVOK'),
  base('18005KT 6000 NSC')
]) {
  const once = norm(raw);
  const twice = norm(once);
  const three = norm(twice);
  assert.equal(twice, once, `drugie przejście zmieniło TAF: ${raw}`);
  assert.equal(three, once, `trzecie przejście zmieniło TAF: ${raw}`);
}

// Na stronie może działać tylko jeden końcowy właściciel tekstu TAF.
const loader = fs.readFileSync(path.join(__dirname, '..', 'message-archive-client.js'), 'utf8');
assert.match(loader, /loadPolicy\('taf-instruction-guard\.js'/);
for (const competing of [
  'taf-cloud-policy.js',
  'taf-weather-policy.js',
  'taf-output-sanitizer.js',
  'taf-radar-nowcast-sync.js',
  'taf-gust-policy.js',
  'taf-cavok-nsc-policy.js'
]) {
  assert.ok(!loader.includes(`loadPolicy('${competing}'`), `${competing} nie może niezależnie nadpisywać #taf`);
}

console.log('TAF stability tests: OK');
