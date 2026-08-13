
const fs = require('fs');
const path = require('path');
try {
  fs.mkdirSync(path.join(__dirname, '.state'), { recursive: true });
  fs.appendFileSync(path.join(__dirname, '.state', 'invocations.log'),
    new Date().toISOString() + ' ' + path.basename(__filename) + '\n');
} catch {}

const { load } = require('./lib');
const d = load();
const byId = Object.fromEntries(d.categories.map(c => [c.id, c]));

console.log('id  category            item                      price');
for (const it of d.items) {
  console.log(
    String(it.id).padEnd(4) +
    (byId[it.categoryId] ? byId[it.categoryId].name : '?').padEnd(20) +
    it.label.padEnd(26) +
    String(it.price).padStart(9)
  );
}
console.log('\n' + d.items.length + ' row(s)');
