// Controlla che i numeri di regola citati in engine/ e test/ esistano nelle Comprehensive Rules.
// Il regolamento non è nel repository: scaricalo da magic.wizards.com/rules, convertilo in testo e passalo allo script.
//   pdftotext -layout MagicCompRules.pdf cr.txt && node scripts/verifica-citazioni.js cr.txt
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts/verifica-citazioni.js <regolamento.txt>');
  process.exit(2);
}
const known = new Set();
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = line.trim().match(/^(\d{3}\.\d+[a-z]?)\.? /);
  if (m) known.add(m[1]);
}
const root = path.join(__dirname, '..');
const missing = [];
let cited = 0;
for (const dir of ['engine', 'test']) {
  for (const name of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.js'))) {
    fs.readFileSync(path.join(root, dir, name), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/CR (\d{3}\.\d+[a-z]?)/g)) {
        cited++;
        if (!known.has(m[1])) missing.push(`${dir}/${name}:${i + 1}  CR ${m[1]}`);
      }
    });
  }
}
console.log(`${known.size} regole nel file, ${cited} citazioni controllate, ${missing.length} inesistenti`);
missing.forEach((m) => console.log(m));
process.exit(missing.length ? 1 : 0);
