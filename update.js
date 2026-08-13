
const fs = require('fs');
const path = require('path');
try {
  fs.mkdirSync(path.join(__dirname, '.state'), { recursive: true });
  fs.appendFileSync(path.join(__dirname, '.state', 'invocations.log'),
    new Date().toISOString() + ' ' + path.basename(__filename) + '\n');
} catch {}

const { load, save } = require('./lib');
const [id, ...rest] = process.argv.slice(2);
const d = load();
const row = d.items.find(r => r.id === Number(id));
if (!row) { console.error('no item with id ' + id); process.exit(1); }
row.label = rest.join(' ');
save(d);
console.log('updated item ' + id);
