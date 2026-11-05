#!/usr/bin/env node
'use strict';

// Test the actual LEGACY numeric adapter, not an independently reimplemented one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'fog-engine.js'), 'utf8');
const match = source.match(/  const n = v => [^\n]+;/);
assert.ok(match, 'LEGACY numeric adapter not found');
const n = vm.runInNewContext(
  '(() => { const finite = Number.isFinite; ' + match[0] + ' return n; })()'
);
assert.equal(n(null), null, 'missing VIS must not become 0 m');
assert.equal(n(undefined), null, 'missing RH/Td must not become zero');
assert.equal(n(''), null, 'blank model value must be missing');
assert.equal(n('  '), null, 'whitespace model value must be missing');
assert.equal(n('0'), 0, 'genuine zero remains valid');
assert.equal(n(0), 0);
assert.equal(n('0.5'), 0.5);
assert.equal(n('bad'), null);
console.log('LEGACY missing-value parsing: OK');
