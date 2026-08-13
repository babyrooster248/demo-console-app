
const fs = require('fs');
const path = require('path');
try {
  fs.mkdirSync(path.join(__dirname, '.state'), { recursive: true });
  fs.appendFileSync(path.join(__dirname, '.state', 'invocations.log'),
    new Date().toISOString() + ' ' + path.basename(__filename) + '\n');
} catch {}

const { load } = require('./lib');
const d = load();
console.log('catalog ready: ' + d.categories.length + ' categories, ' + d.items.length + ' items');
