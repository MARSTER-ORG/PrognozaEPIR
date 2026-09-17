'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pages = fs.readdirSync(ROOT).filter(name => name.endsWith('.html')).sort();
const missing = [];

function localTarget(value) {
  if (!value) return null;
  const raw = value.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('?')) return null;
  if (/^(?:https?:|mailto:|tel:|data:|blob:|javascript:|about:|\/\/)/i.test(raw)) return null;
  const clean = raw.split('#')[0].split('?')[0];
  if (!clean || clean.includes('${') || clean.includes('{{')) return null;
  try { return decodeURIComponent(clean); } catch (_) { return clean; }
}

for (const page of pages) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const dir = path.dirname(path.join(ROOT, page));
  const re = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html))) {
    const target = localTarget(match[1]);
    if (!target) continue;
    const resolved = path.resolve(dir, target);
    if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) continue;
    if (!fs.existsSync(resolved)) missing.push(`${page} -> ${target}`);
  }
}

assert.deepStrictEqual(missing, [], `Missing local page assets:\n${missing.join('\n')}`);
console.log(`site asset integrity: OK (${pages.length} HTML pages)`);
