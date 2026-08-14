
const fs = require('fs');
const path = require('path');
try {
  fs.mkdirSync(path.join(__dirname, '.state'), { recursive: true });
  fs.appendFileSync(path.join(__dirname, '.state', 'invocations.log'),
    new Date().toISOString() + ' ' + path.basename(__filename) + '\n');
} catch {}

const { load, config } = require('./lib');

const args = process.argv.slice(2);
const all = args.includes('--all');
const out = args.find(a => !a.startsWith('--')) || 'catalog-export.csv';

const d = load();
const cfg = config();
const byId = Object.fromEntries(d.categories.map(c => [c.id, c]));

// Default is live rows only: an inactive item is out, and so is every item whose
// category is inactive. Pass --all to dump the raw table instead.
const rows = d.items.filter(it => {
  if (all) return true;
  const cat = byId[it.categoryId];
  return it.active && cat && cat.active;
});

// Semicolon, not comma: finance opens this in Excel under the vi-VN locale, where the list
// separator is `;` and a comma-delimited file collapses into a single column.
const SEP = ';';

const cell = (v) => {
  const s = String(v);
  return /["\r\n]/.test(s) || s.includes(SEP) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const lines = [['id', 'category', 'item', 'price', 'currency']];
for (const it of rows) {
  lines.push([
    it.id,
    byId[it.categoryId] ? byId[it.categoryId].name : '?',
    it.label,
    it.price,          // integer VND, written as stored
    cfg.currency
  ]);
}

// BOM + CRLF so Excel opens the Vietnamese labels without mangling them.
fs.writeFileSync(out, '﻿' + lines.map(r => r.map(cell).join(SEP)).join('\r\n') + '\r\n');
console.log('wrote ' + rows.length + ' row(s) to ' + out + (all ? ' (including inactive)' : ''));
