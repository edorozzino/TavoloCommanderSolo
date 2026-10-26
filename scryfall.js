// Recupero dati carte da Scryfall, con cache su disco.
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'data', 'cards-cache.json');
const HEADERS = {
  'User-Agent': 'CommanderTable/1.0 (tavolo virtuale locale)',
  Accept: 'application/json',
};

let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch {
  cache = {};
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  }, 500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Scryfall chiede al massimo ~10 richieste al secondo
let nextSlot = 0;
async function throttle() {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Date.now() + wait + 100;
  if (wait) await sleep(wait);
}
const key = (name) => name.trim().toLowerCase();
// Le voci salvate dalle versioni precedenti non hanno il testo della carta o l'artista: le aggiorno
const complete = (info) => info?.oracle != null && info.artist !== undefined;

function simplify(card) {
  const faces = card.card_faces || [];
  const img = card.image_uris ? card.image_uris.normal : faces[0]?.image_uris?.normal;
  const imgBack = !card.image_uris && faces[1]?.image_uris ? faces[1].image_uris.normal : null;
  const oracle = card.oracle_text ?? faces.map((f) => f.oracle_text || '').join('\n');
  return {
    name: card.name,
    img: img || null,
    imgBack,
    art: card.image_uris?.art_crop || faces[0]?.image_uris?.art_crop || null,
    artist: card.artist || faces[0]?.artist || null,
    type: card.type_line || faces[0]?.type_line || '',
    manaCost: card.mana_cost ?? faces.map((f) => f.mana_cost).filter(Boolean).join(' // '),
    cmc: card.cmc ?? 0,
    colorIdentity: card.color_identity || [],
    legal: card.legalities?.commander || 'not_legal',
    oracle,
    rarity: card.rarity || '',
    anyNumber: /any number of cards named/i.test(oracle),
    power: card.power ?? faces[0]?.power ?? null,
    toughness: card.toughness ?? faces[0]?.toughness ?? null,
  };
}

function remember(card, requestedName) {
  const info = simplify(card);
  cache[key(card.name)] = info;
  // Il nome di una faccia non deve coprire una carta diversa che si chiama esattamente così
  // (es. "Rampant Growth" è sia una stregoneria sia la faccia di un'altra carta)
  for (const f of card.card_faces || []) {
    const existing = cache[key(f.name)];
    if (!existing || key(existing.name) !== key(f.name)) cache[key(f.name)] = info;
  }
  if (requestedName && !cache[key(requestedName)]) cache[key(requestedName)] = info;
  return info;
}

async function fetchJson(url, options = {}) {
  await throttle();
  const res = await fetch(url, { ...options, headers: { ...HEADERS, ...(options.headers || {}) } });
  if (!res.ok && res.status !== 404) throw new Error(`Scryfall ${res.status}`);
  return res.status === 404 ? null : res.json();
}

// Restituisce { found: Map(nome richiesto -> info), notFound: [nomi] }
async function lookupCards(names) {
  const found = new Map();
  const missing = [];
  for (const n of new Set(names)) {
    if (complete(cache[key(n)])) found.set(n, cache[key(n)]);
    else missing.push(n);
  }

  const stillMissing = [];
  for (let i = 0; i < missing.length; i += 75) {
    const batch = missing.slice(i, i + 75);
    const data = await fetchJson('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
    });
    for (const card of data?.data || []) remember(card);
    for (const n of batch) {
      if (complete(cache[key(n)])) found.set(n, cache[key(n)]);
      else stillMissing.push(n);
    }
  }

  // Seconda passata con ricerca approssimata (carte split, refusi, ecc.)
  const notFound = [];
  for (const n of stillMissing) {
    const card = await fetchJson(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(n)}`);
    if (card && card.object === 'card') found.set(n, remember(card, n));
    else notFound.push(n);
  }

  scheduleSave();
  return { found, notFound };
}

async function lookupToken(name) {
  const k = 'token:' + key(name);
  if (cache[k]) return cache[k];
  const q = `t:token !"${name.replace(/"/g, '')}"`;
  const data = await fetchJson(
    `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=released&dir=desc`
  );
  const list = data?.data || [];
  const exact = list.find((c) => key(c.name) === key(name)) || list[0];
  if (!exact) return null;
  const info = simplify(exact);
  // Per i token a doppia faccia mostriamo la faccia richiesta
  if (exact.card_faces) {
    const face = exact.card_faces.find((f) => key(f.name) === key(name));
    if (face?.image_uris) {
      info.img = face.image_uris.normal;
      info.imgBack = null;
      info.name = face.name;
      info.type = face.type_line || info.type;
      info.power = face.power ?? null;
      info.toughness = face.toughness ?? null;
    }
  }
  cache[k] = info;
  scheduleSave();
  return info;
}

// Ricerca libera con la sintassi di Scryfall; i risultati brevi restano in memoria per 10 minuti
const searchCache = new Map();
async function searchCards(q, order = 'edhrec', page = 1) {
  const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=${encodeURIComponent(order)}&page=${page}&unique=cards`;
  const hit = searchCache.get(url);
  if (hit && Date.now() - hit.ts < 600000) return hit.data;
  await throttle();
  const res = await fetch(url, { headers: HEADERS });
  const json = await res.json();
  let data;
  if (res.status === 404) data = { cards: [], total: 0, hasMore: false };
  else if (!res.ok) data = { error: json.details || `Errore Scryfall ${res.status}` };
  else {
    data = { cards: json.data.map((c) => remember(c)), total: json.total_cards, hasMore: !!json.has_more };
    scheduleSave();
  }
  searchCache.set(url, { ts: Date.now(), data });
  if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value);
  return data;
}

module.exports = { lookupCards, lookupToken, searchCards };
