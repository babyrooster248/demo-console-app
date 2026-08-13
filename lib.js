const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'data', 'catalog.json');
const load = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
const config = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

module.exports = { load, save, config };
