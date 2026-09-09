'use strict';
const assert = require('node:assert/strict');
const {normalizeTafTerminator} = require('../taf-output-sanitizer.js');

assert.equal(
  normalizeTafTerminator('TAF EPIR 091700Z 0918/1006 26006KT 9999 -RA = = = NSC='),
  'TAF EPIR 091700Z 0918/1006 26006KT 9999 -RA NSC='
);
assert.equal(
  normalizeTafTerminator('TAF EPIR 091700Z 0918/1006 26006KT 9999 -RA NSC===='),
  'TAF EPIR 091700Z 0918/1006 26006KT 9999 -RA NSC='
);
assert.equal(
  normalizeTafTerminator('TAF EPIR 091700Z 0918/1006 26006KT 9999 -RA NSC\nBECMG 0921/0923 6000 BR==='),
  'TAF EPIR 091700Z 0918/1006 26006KT 9999 -RA NSC\nBECMG 0921/0923 6000 BR='
);
assert.equal((normalizeTafTerminator('TAF EPIR 091700Z 0918/1006 26006KT CAVOK=').match(/=/g) || []).length, 1);

console.log('TAF output terminator sanitizer tests: OK');
