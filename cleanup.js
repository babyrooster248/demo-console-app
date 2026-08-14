
const fs = require('fs');
const path = require('path');
try {
  fs.mkdirSync(path.join(__dirname, '.state'), { recursive: true });
  fs.appendFileSync(path.join(__dirname, '.state', 'invocations.log'),
    new Date().toISOString() + ' ' + path.basename(__filename) + '\n');
} catch {}

const { load } = require('./lib');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const file = path.join(__dirname, 'data', 'catalog.json');
const lock = path.join(__dirname, 'data', '.catalog.lock');
const tmp = file + '.tmp';

const d = load();
const byId = Object.fromEntries(d.categories.map(c => [c.id, c]));

// Only the item-level flag, as asked. Categories are left alone, so an item that is
// active: true under an inactive category survives cleanup — it is reported below,
// because report.js will count it while export.js will not.
const kept = d.items.filter(it => it.active);
const dropped = d.items.filter(it => !it.active);

// New ids run 1..n in the order the rows already appear in the file.
const remap = [];
kept.forEach((it, i) => {
  const next = i + 1;
  if (it.id !== next) remap.push({ from: it.id, to: next, label: it.label });
  it.id = next;
});

// kept holds the same objects as d.items, so renumbering above mutated them in place —
// but d.items still lists the dropped rows too. Swap in the filtered array, or the write
// below keeps every item and emits duplicate ids.
d.items = kept;

// Nothing in the repo points at an item id from outside data/catalog.json (categoryId
// refers to categories, which are untouched), so renumbering is safe on disk. Callers
// holding an old id are not — see the note printed at the end.

for (const it of dropped) console.log('drop   id ' + it.id + '  ' + it.label);
for (const r of remap) console.log('renum  id ' + r.from + ' -> ' + r.to + '  ' + r.label);

const orphaned = kept.filter(it => {
  const cat = byId[it.categoryId];
  return !cat || !cat.active;
});
for (const it of orphaned) {
  const cat = byId[it.categoryId];
  console.log('keep   id ' + it.id + '  ' + it.label +
    '  (category "' + (cat ? cat.name : '?') + '" is ' + (cat ? 'inactive' : 'missing') +
    ' — kept, export.js still hides it)');
}

if (dryRun) {
  console.log('\n--dry-run: nothing written. ' + kept.length + ' item(s) would remain, ' +
    dropped.length + ' removed.');
  process.exit(0);
}

// update.js rewrites this whole file too, so a concurrent run would lose one of the two
// edits. Take an exclusive lock, then swap the file in with a rename so a crash mid-write
// cannot leave a truncated catalog behind.
try {
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
} catch (e) {
  if (e.code === 'EEXIST') {
    console.error('data/.catalog.lock exists — another write is in progress. ' +
      'Delete it if no such process is running.');
    process.exit(1);
  }
  throw e;
}

try {
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
  fs.renameSync(tmp, file);
} finally {
  try { fs.unlinkSync(tmp); } catch {}
  fs.unlinkSync(lock);
}

console.log('\nwrote ' + kept.length + ' item(s) to data/catalog.json (' +
  dropped.length + ' removed, ids renumbered from 1)');
if (remap.length) {
  console.log('ids changed — a CSV already sent to finance now disagrees with the file, ' +
    'and update.js <id> needs the new numbers.');
}
