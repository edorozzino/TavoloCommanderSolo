// Al posto del disco, nel browser i "file" stanno nella memoria del dispositivo (localStorage).
// Così decks.js e scryfall.js funzionano senza modifiche anche sul telefono.
const SEED = { '/data/decks.json': JSON.stringify(require('../../data/decks.json')) }; // mazzi di partenza

const key = (file) => 'ct-file:' + file;

function readFileSync(file) {
  let text = null;
  try { text = localStorage.getItem(key(file)); } catch { /* memoria non disponibile */ }
  if (text == null) text = SEED[file] ?? null;
  if (text == null) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  return text;
}

function writeFileSync(file, text) {
  try {
    localStorage.setItem(key(file), String(text));
  } catch {
    // memoria piena (di solito per la cache delle carte): si libera la cache e si riprova una volta
    try {
      localStorage.removeItem(key('/data/cards-cache.json'));
      localStorage.setItem(key(file), String(text));
    } catch { /* si continua senza salvare */ }
  }
}

function renameSync(from, to) {
  writeFileSync(to, readFileSync(from));
  try { localStorage.removeItem(key(from)); } catch { /* niente da togliere */ }
}

module.exports = { readFileSync, writeFileSync, renameSync, mkdirSync() {} };
