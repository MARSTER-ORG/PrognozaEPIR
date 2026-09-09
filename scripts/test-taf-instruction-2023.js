'use strict';
const assert = require('node:assert/strict');
const guard = require('../taf-instruction-guard.js');

const NOW = Date.UTC(2026, 8, 9, 5, 0, 0);
const H = 3600e3;
const base = body => `TAF EPIR 090500Z 0906/0918 ${body}=`;
const norm = (raw, series = [], extra = {}) => guard.normalize(raw, {now:NOW, series, ...extra});
const lineSeries = (hours, speedMs, gustMs, wd = 180) => hours.map(h => ({
  t: Date.UTC(2026,8,9,h), WS:speedMs, G:gustMs, WD:wd, count:8
}));

// 3.6.2: visibility coding increments.
assert.equal(guard.normalizeVisibilityCode('0473'), '0450');
assert.equal(guard.normalizeVisibilityCode('0837'), '0800');
assert.equal(guard.normalizeVisibilityCode('4567'), '4600');
assert.equal(guard.normalizeVisibilityCode('5780'), '6000');
assert.equal(guard.normalizeVisibilityValue(10000), 9999);
assert.equal(guard.visibilityBand(799), 0);
assert.equal(guard.visibilityBand(800), 1);
assert.equal(guard.visibilityBand(1500), 2);
assert.equal(guard.visibilityBand(3000), 3);
assert.equal(guard.visibilityBand(5000), 4);

// 3.8.a: cloud ceiling thresholds are feet, not metres.
assert.equal(guard.ceilingBandFt(199), 0);
assert.equal(guard.ceilingBandFt(200), 1);
assert.equal(guard.ceilingBandFt(300), 2);
assert.equal(guard.ceilingBandFt(500), 3);
assert.equal(guard.ceilingBandFt(1000), 4);
assert.equal(guard.ceilingBandFt(1500), 5);

// EPIR local rule: CAVOK and NSC both use 1500 m (~4921 ft).
let r = norm(base('18005KT 9999 BKN049'));
assert.match(r.text, /9999 BKN049=/, '4900 ft must block CAVOK because it is below 1500 m');
r = norm(base('18005KT 9999 BKN050'));
assert.match(r.text, /18005KT CAVOK=/, '5000 ft does not block the 1500 m CAVOK floor');
r = norm(base('18005KT 3000 BKN050'));
assert.match(r.text, /18005KT 3000 NSC=/, '5000 ft ordinary cloud is above the EPIR 1500 m / 4921 ft NSC threshold');
assert.ok(Math.abs(guard.constants.NSC_LIMIT_FT - guard.constants.CAVOK_BASE_LIMIT_FT) < 0.01);
r = norm(base('18005KT 9999 BKN050'), [], {msaFt:6000});
assert.match(r.text, /18005KT CAVOK=/, 'EPIR uses the fixed 1500 m / 4921 ft threshold for both CAVOK and NSC');

// 3.7.12: MIFG/BCFG/PRFG not coded in military TAF.
r = norm(base('18005KT 3000 MIFG NSC'));
assert.doesNotMatch(r.text, /\bMIFG\b/);
assert.match(r.text, /3000 NSC=/);

// 1.7(k), 3.13: PROB40 forbidden.
r = norm(base('18005KT CAVOK').replace(/=$/, '\nPROB40 0910/0912 3000 BR='));
assert.doesNotMatch(r.text, /\bPROB40\b/);

// 3.8.11: no vertical visibility.
r = norm(base('18005KT 0500 FG VV002'));
assert.doesNotMatch(r.text, /\bVV002\b/);

// 3.7.a.2: continuing weather must be repeated after BECMG.
r = norm('TAF EPIR 090500Z 0906/0918 18005KT 3000 RA BR BKN010\nBECMG 0910/0912 BKN005=');
assert.match(r.text, /BECMG 0910\/0912 RA BR BKN005=/);

// 3.7.a.2 also applies when a TEMPO group changes another element.
r = norm('TAF EPIR 090500Z 0906/0918 18005KT 3000 RA BR BKN010\nTEMPO 0910/0912 BKN005=');
assert.match(r.text, /TEMPO 0910\/0912 RA BR BKN005=/);

// 3.8.a.1: CB/TCU cloud change repeats all ordinary cloud layers.
r = norm('TAF EPIR 090500Z 0906/0918 18005KT 9999 SCT020 BKN040\nTEMPO 0910/0912 SCT015CB=');
assert.match(r.text, /TEMPO 0910\/0912 SCT015CB SCT020 BKN040=/);

// 3.10.3: BECMG never exceeds four hours.
r = norm('TAF EPIR 090500Z 0906/0918 18005KT CAVOK\nBECMG 0908/0914 27015KT=');
assert.match(r.text, /BECMG 0908\/0912 27015KT=/);

// 3.9.2 / 3.14.1: no more than five change groups.
r = norm('TAF EPIR 090500Z 0906/0918 18005KT CAVOK\n' + [
  'BECMG 0907/0908 19015KT','TEMPO 0908/0909 20015KT','PROB30 0909/0910 3000 BR',
  'BECMG 0910/0911 21025KT','TEMPO 0911/0912 4000 RA','PROB30 0912/0913 BKN005'
].join('\n') + '=');
assert.ok((r.text.match(/(?:^|\n)(?:BECMG|TEMPO|PROB30|FM\d{6})\b/g)||[]).length <= 5);

// 3.5.5: P99KT for 100 kt or more; model row corrects a legacy 99KT token.
const p99Series = [{t:Date.UTC(2026,8,9,6), WS:52, G:52, WD:270, count:8}]; // ~101 kt
r = norm(base('27099KT CAVOK'), p99Series);
assert.match(r.text, /270P99KT CAVOK=/);

// 3.5.a(c) + local project rule: transient gusts are TEMPO only when mean >=15 kt.
const transient = lineSeries([8,9], 8, 14); // mean ~15.6 kt, gap >10 kt
r = norm(base('18016G28KT CAVOK'), transient);
assert.match(r.text, /18016KT CAVOK/);
assert.match(r.text, /TEMPO 0908\/0910 18016G27KT=/);

// Mean below 15 kt: gust alone must not create a change group.
const weakMean = lineSeries([8,9], 5, 11); // mean ~9.7 kt
r = norm(base('18010G21KT CAVOK'), weakMean);
assert.doesNotMatch(r.text, /G\d{2,3}KT/);
assert.doesNotMatch(r.text, /TEMPO 0908\/0910/);
assert.ok(r.allIssues.some(x => x.code === 'GUST_LT15'));

// Project rule: if strong gusty wind persists >=4 h, gust is prevailing, not TEMPO.
const persistent = lineSeries([6,7,8,9,10,11], 8, 14); // >=6 h, mean ~15.6 kt
r = norm(base('18016G28KT CAVOK'), persistent);
assert.match(r.text.split('\n')[0], /18016G27KT CAVOK/);
assert.doesNotMatch(r.text, /TEMPO .*G27KT/);
assert.ok(r.gustEpisodes.some(x => x.persistent && x.durationH >= 4));

// Group output remains chronological after gust insertion.
const laterTransient = lineSeries([14,15], 8, 14);
r = norm('TAF EPIR 090500Z 0906/0918 18016KT CAVOK\nBECMG 0910/0912 20026KT=', laterTransient);
const lines = r.text.split('\n');
assert.match(lines[1], /^BECMG 0910\/0912/);
assert.match(lines[2], /^TEMPO 0914\/0916/);

// Basic 12 h / one-hour-before validity checks.
r = norm(base('18005KT CAVOK'));
assert.equal(Math.round((r.times.end-r.times.start)/H), 12);
assert.equal(Math.round((r.times.start-r.times.issue)/H), 1);
assert.ok(!r.validation.some(x => x.level === 'error'));

console.log('TAF Instruction 11.2023 tests: OK');
