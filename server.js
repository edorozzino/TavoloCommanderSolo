// Tavolo virtuale Commander: server HTTP + WebSocket per giocare in rete locale.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { lookupCards, lookupToken, searchCards } = require('./scryfall');
const decks = require('./decks');
const { STARTER_DECKS } = require('./engine/decks');
const autoplay = require('./autoplay');
const { createAuth, loginPage, generatePassword } = require('./auth');
const tailscale = require('./tailscale');

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
// HTTPS facoltativo: serve per installare l'app sui telefoni in rete locale (le PWA richiedono una connessione sicura)
const CERT_DIR = path.join(__dirname, 'certs');
const PUBLIC_DIR = path.join(__dirname, 'public');
// --funnel pubblica il tavolo su internet (con Tailscale Funnel), --tailscale solo nella propria rete Tailscale
const FUNNEL = process.argv.includes('--funnel');
const USE_TAILSCALE = FUNNEL || process.argv.includes('--tailscale') || process.env.TAILSCALE === '1';
// TAVOLO_PASSWORD=auto, oppure il tavolo pubblico su internet senza password, ne genera una nuova a ogni avvio
const GENERATED_PASSWORD = process.env.TAVOLO_PASSWORD === 'auto' || (FUNNEL && !process.env.TAVOLO_PASSWORD);
const PASSWORD = GENERATED_PASSWORD ? generatePassword() : process.env.TAVOLO_PASSWORD;
const auth = createAuth(PASSWORD);
let publicAccess = null; // { url, funnel } quando il tavolo è pubblicato con Tailscale
const MAX_PLAYERS = 6;
const COLORS = ['#e05252', '#4f8fe0', '#4fbf6a', '#d9a33b', '#a565d9', '#3bbfbf'];
const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
const ZONE_NAMES = {
  library: 'grimorio',
  hand: 'mano',
  battlefield: 'campo di battaglia',
  graveyard: 'cimitero',
  exile: 'esilio',
  command: 'zona di comando',
};

// ---------- HTTP statico ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// API per l'editor dei mazzi
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', risorsa, id?]
  const [, resource, rid] = parts;
  if (resource === 'search' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').slice(0, 500);
    if (!q.trim()) return sendJson(res, 400, { error: 'Ricerca vuota' });
    const page = Math.max(1, Math.min(50, Number(url.searchParams.get('page')) || 1));
    const order = ['name', 'cmc', 'edhrec', 'released', 'usd'].includes(url.searchParams.get('order')) ? url.searchParams.get('order') : 'edhrec';
    return sendJson(res, 200, await searchCards(q, order, page));
  }
  if (resource === 'cards' && req.method === 'POST') {
    const body = await readBody(req);
    const names = (Array.isArray(body.names) ? body.names : []).map(String).slice(0, 300);
    const { found, notFound } = await lookupCards(names);
    return sendJson(res, 200, { cards: Object.fromEntries(found), notFound });
  }
  if (resource === 'invite' && req.method === 'GET') {
    // indirizzi da cui gli amici possono raggiungere il tavolo, dal più comodo; la chiave fa entrare senza scrivere la password
    const addresses = [];
    if (publicAccess) addresses.push({ url: publicAccess.url, label: publicAccess.funnel ? 'Da internet' : 'Rete Tailscale', note: publicAccess.funnel ? '' : 'Serve Tailscale acceso sul dispositivo' });
    const tailnet = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip); // indirizzi interni di Tailscale
    for (const ip of ips.filter((x) => !tailnet(x))) addresses.push({ url: `http://${ip}:${PORT}`, label: 'Stessa Wi-Fi', note: 'Solo per chi è collegato alla tua rete' });
    return sendJson(res, 200, { addresses, key: auth.enabled ? PASSWORD : null });
  }
  if (resource === 'starter-decks' && req.method === 'GET') {
    return sendJson(res, 200, STARTER_DECKS.map((d, i) => ({
      id: `starter-${i}`, name: d.name, style: d.style, commanders: [d.commander], cards: d.cards, maybe: [],
      count: d.cards.reduce((n, e) => n + e.count, 0) + 1,
    })));
  }
  if (resource === 'decks') {
    if (req.method === 'GET' && !rid) return sendJson(res, 200, decks.list());
    if (req.method === 'GET') {
      const d = decks.get(rid);
      return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Mazzo non trovato' });
    }
    if (req.method === 'POST' && !rid) return sendJson(res, 200, decks.put(null, await readBody(req)));
    if (req.method === 'PUT' && rid) return sendJson(res, 200, decks.put(rid, await readBody(req)));
    if (req.method === 'DELETE' && rid) return sendJson(res, decks.remove(rid) ? 200 : 404, {});
  }
  sendJson(res, 404, { error: 'Non trovato' });
}

function readForm(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e4) req.destroy();
    });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

function sendLogin(res, status, error) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(loginPage(error));
}

// Dopo il login si va alla pagina indicata da ?next= (per esempio il tavolo dell'invito), solo se è di questo sito
function nextPage(url) {
  const next = url.searchParams.get('next') || '/';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

// Login dal modulo (POST) oppure dal link con la password già dentro (/login?k=...)
async function handleLogin(req, res, url) {
  const given = req.method === 'POST' ? (await readForm(req)).get('password') : url.searchParams.get('k');
  const result = auth.attempt(given || '');
  if (result === 'ok') {
    res.writeHead(303, { 'Set-Cookie': auth.loginCookie(req), Location: nextPage(url) });
    res.end();
    return;
  }
  const error = result === 'locked' ? 'Troppi tentativi sbagliati: riprova tra qualche minuto' : 'Password sbagliata';
  setTimeout(() => sendLogin(res, 401, error), 1000); // rallenta chi prova a indovinarla
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (auth.enabled) {
    if (url.pathname === '/login' && (req.method === 'POST' || url.searchParams.has('k'))) return handleLogin(req, res, url);
    if (!auth.isAuthorized(req) && !auth.isPublic(url.pathname)) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Serve la password del tavolo' });
      return sendLogin(res, 401);
    }
  }
  if (url.pathname === '/login') {
    res.writeHead(303, { Location: nextPage(url) });
    res.end();
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error(e);
      sendJson(res, 500, { error: e.message });
    });
    return;
  }
  const urlPath = decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Non trovato');
      return;
    }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
    if (path.basename(file) === 'sw.js') headers['Cache-Control'] = 'no-cache'; // il service worker si aggiorna subito
    res.writeHead(200, headers);
    res.end(data);
  });
});

// ---------- Stato di gioco ----------
const rooms = new Map();
const id = () => crypto.randomBytes(6).toString('hex');

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { code, players: new Map(), order: [], log: [], active: null, turn: 0, sockets: new Set() });
  }
  return rooms.get(code);
}

function newPlayer(room, name) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  const p = {
    id: id(),
    name: name.slice(0, 24) || 'Giocatore',
    color: COLORS.find((c) => !used.has(c)) || COLORS[0],
    connected: true,
    life: 40,
    poison: 0,
    cmdDmg: {}, // iid del comandante avversario -> danni subiti
    handRevealed: false,
    peek: null, // numero di carte del grimorio che il giocatore sta guardando, o 'all'
    deck: null, // ultima lista caricata, per ricominciare
    mulligans: 0,
    zones: Object.fromEntries(ZONES.map((z) => [z, []])),
  };
  room.players.set(p.id, p);
  room.order.push(p.id);
  return p;
}

function log(room, text, pid = null) {
  room.log.push({ ts: Date.now(), text, pid });
  if (room.log.length > 300) room.log.shift();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function makeCard(info, owner, extra = {}) {
  return {
    iid: id(),
    name: info.name,
    img: info.img,
    imgBack: info.imgBack,
    artist: info.artist || null,
    art: info.art || null,
    type: info.type,
    pt: info.power != null ? `${info.power}/${info.toughness}` : null,
    owner,
    tapped: false,
    flipped: false,
    faceDown: false,
    counters: {},
    x: 0,
    y: 0,
    isCommander: false,
    casts: 0,
    token: false,
    ...extra,
  };
}

function findCard(room, iid) {
  for (const p of room.players.values()) {
    for (const z of ZONES) {
      const i = p.zones[z].findIndex((c) => c.iid === iid);
      if (i >= 0) return { card: p.zones[z][i], player: p, zone: z, index: i };
    }
  }
  return null;
}

function resetCardState(card) {
  card.tapped = false;
  card.flipped = false;
  card.faceDown = false;
  card.counters = {};
}

function cardLabel(card, zone) {
  return card.faceDown && zone !== 'battlefield' ? 'una carta' : card.faceDown ? 'una carta a faccia in giù' : card.name;
}

// Sposta una carta. Fuori dal campo di battaglia le carte tornano sempre alle zone del proprietario.
function moveCard(room, actor, iid, to, quiet = false) {
  const found = findCard(room, iid);
  if (!found) return;
  const { card, player: from, zone: fromZone, index } = found;
  if (from.id !== actor.id && card.owner !== actor.id) return;
  const zone = ZONES.includes(to.zone) ? to.zone : 'battlefield';
  const dest = zone === 'battlefield' && room.players.has(to.player) ? room.players.get(to.player) : room.players.get(card.owner) || from;

  from.zones[fromZone].splice(index, 1);

  // I token smettono di esistere quando lasciano il campo di battaglia
  if (card.token && zone !== 'battlefield') {
    if (!quiet) log(room, `${actor.name}: il token ${card.name} lascia il campo di battaglia`, actor.id);
    return;
  }

  if (zone === 'battlefield') {
    card.x = clamp(Number(to.x) || 0, 0, 92);
    card.y = clamp(Number(to.y) || 0, 0, 85);
    if (fromZone !== 'battlefield') {
      resetCardState(card);
      card.faceDown = !!to.faceDown;
    }
  } else {
    resetCardState(card);
    if (zone === 'exile' && to.faceDown) card.faceDown = true;
  }

  if (card.isCommander && fromZone === 'command' && zone === 'battlefield') card.casts++;

  const list = dest.zones[zone];
  if (zone === 'library' && to.position === 'bottom') list.push(card);
  else if (zone === 'library') list.unshift(card);
  else if (zone === 'hand' && Number.isInteger(to.index)) list.splice(to.index, 0, card);
  else list.push(card);

  if (quiet || (fromZone === 'battlefield' && zone === 'battlefield' && from.id === dest.id)) return; // nessun messaggio per i riposizionamenti

  const hidden = (fromZone === 'hand' || fromZone === 'library') && (zone === 'hand' || zone === 'library');
  const what = hidden ? 'una carta' : cardLabel(card, zone);
  let where = ZONE_NAMES[zone];
  if (zone === 'library') where = to.position === 'bottom' ? 'in fondo al grimorio' : 'in cima al grimorio';
  if (zone === 'battlefield' && dest.id !== actor.id) where = `campo di battaglia di ${dest.name}`;
  let msg = `${actor.name}: ${what} da ${ZONE_NAMES[fromZone]} → ${where}`;
  if (card.isCommander && fromZone === 'command' && zone === 'battlefield') {
    msg = `${actor.name} lancia il comandante ${card.name} (tassa pagata: ${2 * (card.casts - 1)})`;
  }
  log(room, msg, actor.id);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function draw(room, p, n) {
  let drawn = 0;
  for (let i = 0; i < n && p.zones.library.length; i++) {
    const c = p.zones.library.shift();
    resetCardState(c);
    p.zones.hand.push(c);
    drawn++;
  }
  return drawn;
}

// Rimuove dal tavolo tutte le carte possedute da un giocatore (anche sotto il controllo altrui)
function collectOwned(room, p) {
  const owned = [];
  for (const other of room.players.values()) {
    for (const z of ZONES) {
      other.zones[z] = other.zones[z].filter((c) => {
        if (c.owner !== p.id) return true;
        if (!c.token) owned.push(c);
        return false;
      });
    }
  }
  return owned;
}

function setupDeck(room, p) {
  const cards = collectOwned(room, p);
  for (const c of cards) {
    resetCardState(c);
    c.casts = 0;
    if (c.isCommander) p.zones.command.push(c);
    else p.zones.library.push(c);
  }
  shuffle(p.zones.library);
  p.life = 40;
  p.poison = 0;
  p.cmdDmg = {};
  p.mulligans = 0;
  p.peek = null;
  p.handRevealed = false;
}

// ---------- Azioni ----------
const actions = {
  async loadDeck(room, p, msg, ws) {
    const main = (msg.main || []).filter((e) => e && e.name).slice(0, 250);
    const commanders = (msg.commanders || []).filter(Boolean).slice(0, 4);
    const names = [...main.map((e) => e.name), ...commanders];
    send(ws, { t: 'info', msg: 'Recupero le carte da Scryfall…' });
    let result;
    try {
      result = await lookupCards(names);
    } catch (e) {
      send(ws, { t: 'error', msg: 'Impossibile contattare Scryfall: ' + e.message });
      return;
    }
    collectOwned(room, p);
    for (const z of ZONES) p.zones[z] = [];
    for (const name of commanders) {
      const info = result.found.get(name);
      if (info) p.zones.command.push(makeCard(info, p.id, { isCommander: true }));
    }
    let total = 0;
    for (const e of main) {
      const info = result.found.get(e.name);
      if (!info) continue;
      const count = clamp(Number(e.count) || 1, 1, 99);
      for (let i = 0; i < count; i++) p.zones.library.push(makeCard(info, p.id));
      total += count;
    }
    p.deck = { main, commanders };
    setupDeck(room, p);
    const cmdNames = p.zones.command.map((c) => c.name).join(' e ') || 'nessun comandante';
    log(room, `${p.name} carica un mazzo: ${cmdNames} + ${total} carte`, p.id);
    const notLegendary = p.zones.command.filter((c) => !/legendary|leggendari/i.test(c.type)).map((c) => c.name);
    send(ws, { t: 'deckResult', notFound: result.notFound, notLegendary, total, commanders: p.zones.command.length });
  },

  restart(room, p) {
    if (!p.deck) return;
    setupDeck(room, p);
    log(room, `${p.name} ricomincia la partita (mazzo mescolato, vita 40)`, p.id);
  },

  draw(room, p, msg) {
    const n = clamp(Number(msg.n) || 1, 1, 30);
    const d = draw(room, p, n);
    log(room, `${p.name} pesca ${d} cart${d === 1 ? 'a' : 'e'}${d < n ? ' (grimorio esaurito!)' : ''}`, p.id);
  },

  shuffle(room, p) {
    shuffle(p.zones.library);
    p.peek = null;
    log(room, `${p.name} mescola il grimorio`, p.id);
  },

  mulligan(room, p) {
    for (const c of p.zones.hand) resetCardState(c);
    p.zones.library.push(...p.zones.hand);
    p.zones.hand = [];
    shuffle(p.zones.library);
    draw(room, p, 7);
    p.mulligans++;
    const note = p.mulligans === 1 ? ' (il primo è gratuito)' : ` (metti ${p.mulligans - 1} cart${p.mulligans === 2 ? 'a' : 'e'} in fondo)`;
    log(room, `${p.name} prende mulligan n°${p.mulligans}${note}`, p.id);
  },

  move(room, p, msg) {
    moveCard(room, p, msg.iid, msg.to || {});
  },

  moveZone(room, p, msg) {
    // Sposta tutte le carte di una zona propria (es. cimitero → grimorio)
    if (!ZONES.includes(msg.from) || !ZONES.includes(msg.to) || msg.from === msg.to) return;
    const n = p.zones[msg.from].length;
    for (const c of [...p.zones[msg.from]]) moveCard(room, p, c.iid, { zone: msg.to, position: msg.position }, true);
    if (msg.to === 'library' && msg.shuffle) shuffle(p.zones.library);
    if (n) log(room, `${p.name} sposta ${n} cart${n === 1 ? 'a' : 'e'} da ${ZONE_NAMES[msg.from]} → ${ZONE_NAMES[msg.to]}${msg.shuffle ? ' e mescola' : ''}`, p.id);
  },

  mill(room, p, msg) {
    const n = clamp(Number(msg.n) || 1, 1, 99);
    const milled = p.zones.library.splice(0, n);
    p.zones.graveyard.push(...milled);
    log(room, `${p.name} macina ${milled.length} cart${milled.length === 1 ? 'a' : 'e'}: ${milled.map((c) => c.name).join(', ')}`, p.id);
  },

  tap(room, p, msg) {
    const f = findCard(room, msg.iid);
    if (!f || f.zone !== 'battlefield' || (f.player.id !== p.id && f.card.owner !== p.id)) return;
    f.card.tapped = msg.value != null ? !!msg.value : !f.card.tapped;
  },

  untapAll(room, p) {
    for (const c of p.zones.battlefield) c.tapped = false;
    log(room, `${p.name} stappa tutti i suoi permanenti`, p.id);
  },

  startTurn(room, p) {
    for (const c of p.zones.battlefield) c.tapped = false;
    const d = draw(room, p, 1);
    room.active = p.id;
    log(room, `— Turno di ${p.name}: stappa tutto e pesca ${d ? 'una carta' : 'nulla (grimorio vuoto!)'} —`, p.id);
  },

  passTurn(room, p) {
    const i = room.order.indexOf(room.active ?? p.id);
    const next = room.players.get(room.order[(i + 1) % room.order.length]);
    room.active = next.id;
    room.turn++;
    log(room, `${p.name} passa il turno a ${next.name}`, p.id);
  },

  flip(room, p, msg) {
    const f = findCard(room, msg.iid);
    if (!f || !f.card.imgBack || (f.player.id !== p.id && f.card.owner !== p.id)) return;
    f.card.flipped = !f.card.flipped;
    log(room, `${p.name} trasforma ${f.card.name}`, p.id);
  },

  faceDown(room, p, msg) {
    const f = findCard(room, msg.iid);
    if (!f || (f.player.id !== p.id && f.card.owner !== p.id)) return;
    f.card.faceDown = !f.card.faceDown;
    log(room, `${p.name} gira ${f.card.faceDown ? 'a faccia in giù una carta' : 'a faccia in su ' + f.card.name}`, p.id);
  },

  counter(room, p, msg) {
    const f = findCard(room, msg.iid);
    if (!f || (f.player.id !== p.id && f.card.owner !== p.id)) return;
    const k = String(msg.key || '').slice(0, 16);
    if (!k) return;
    const v = (f.card.counters[k] || 0) + (Number(msg.delta) || 0);
    if (v === 0) delete f.card.counters[k];
    else f.card.counters[k] = v;
  },

  life(room, p, msg) {
    const d = Math.trunc(Number(msg.delta) || 0);
    if (!d) return;
    p.life += d;
    log(room, `${p.name}: punti vita ${d > 0 ? '+' : ''}${d} → ${p.life}`, p.id);
  },

  poison(room, p, msg) {
    const d = Math.trunc(Number(msg.delta) || 0);
    p.poison = Math.max(0, p.poison + d);
    log(room, `${p.name}: segnalini veleno → ${p.poison}${p.poison >= 10 ? ' (sconfitto!)' : ''}`, p.id);
  },

  cmdDmg(room, p, msg) {
    const f = findCard(room, msg.iid);
    if (!f || !f.card.isCommander) return;
    const d = Math.trunc(Number(msg.delta) || 0);
    const cur = p.cmdDmg[msg.iid] || 0;
    const next = Math.max(0, cur + d);
    if (next === cur) return;
    p.cmdDmg[msg.iid] = next;
    p.life -= next - cur; // il danno da comandante è anche perdita di vita
    log(
      room,
      `${p.name}: danni da ${f.card.name} ${next - cur > 0 ? '+' : ''}${next - cur} → ${next}/21, vita ${p.life}${next >= 21 ? ' (sconfitto!)' : ''}`,
      p.id
    );
  },

  async token(room, p, msg, ws) {
    const name = String(msg.name || '').trim().slice(0, 40);
    if (!name) return;
    const count = clamp(Number(msg.count) || 1, 1, 20);
    let info = null;
    try {
      info = await lookupToken(name);
    } catch {
      info = null;
    }
    if (!info) info = { name, img: null, imgBack: null, type: 'Token', power: null, toughness: null };
    if (msg.pt) [info.power, info.toughness] = String(msg.pt).split('/');
    for (let i = 0; i < count; i++) {
      p.zones.battlefield.push(
        makeCard({ ...info }, p.id, { token: true, x: clamp(5 + i * 3, 0, 92), y: clamp(5 + i * 3, 0, 85) })
      );
    }
    log(room, `${p.name} crea ${count} token ${info.name}`, p.id);
  },

  copyCard(room, p, msg) {
    const f = findCard(room, msg.iid);
    if (!f || f.zone !== 'battlefield' || f.card.faceDown) return;
    const c = f.card;
    p.zones.battlefield.push(
      makeCard(
        { name: c.name, img: c.flipped ? c.imgBack : c.img, imgBack: null, type: c.type, power: null, toughness: null },
        p.id,
        { token: true, pt: c.pt, x: clamp(c.x + 4, 0, 92), y: clamp(c.y + 4, 0, 85) }
      )
    );
    log(room, `${p.name} crea un token copia di ${c.name}`, p.id);
  },

  peek(room, p, msg) {
    p.peek = msg.n === 'all' ? 'all' : msg.n ? clamp(Number(msg.n), 1, 99) : null;
    if (p.peek) log(room, `${p.name} guarda ${p.peek === 'all' ? 'il proprio grimorio' : `le prime ${p.peek} carte del grimorio`}`, p.id);
  },

  revealTop(room, p) {
    const c = p.zones.library[0];
    if (c) log(room, `${p.name} rivela la prima carta del grimorio: ${c.name}`, p.id);
  },

  revealHand(room, p) {
    p.handRevealed = !p.handRevealed;
    log(room, `${p.name} ${p.handRevealed ? 'rivela' : 'nasconde'} la propria mano`, p.id);
  },

  revealCard(room, p, msg) {
    const f = findCard(room, msg.iid);
    if (f && f.card.owner === p.id) log(room, `${p.name} rivela ${f.card.name}`, p.id);
  },

  dice(room, p, msg) {
    const sides = clamp(Number(msg.sides) || 6, 2, 100);
    log(room, `${p.name} tira un d${sides}: ${crypto.randomInt(sides) + 1}`, p.id);
  },

  coin(room, p) {
    log(room, `${p.name} lancia una moneta: ${crypto.randomInt(2) ? 'testa' : 'croce'}`, p.id);
  },

  chat(room, p, msg) {
    const text = String(msg.text || '').trim().slice(0, 300);
    if (text) log(room, `${p.name}: «${text}»`, p.id);
  },

  rename(room, p, msg) {
    const name = String(msg.name || '').trim().slice(0, 24);
    if (name) p.name = name;
  },

  leave(room, p) {
    collectOwned(room, p);
    room.players.delete(p.id);
    room.order = room.order.filter((x) => x !== p.id);
    if (room.active === p.id) room.active = room.order[0] || null;
    for (const other of room.players.values()) {
      for (const k of Object.keys(other.cmdDmg)) if (!findCard(room, k)) delete other.cmdDmg[k];
    }
    log(room, `${p.name} lascia il tavolo`);
  },
};

// ---------- Vista per ciascun giocatore (nasconde le informazioni private) ----------
// Le carte scoperte sono pubbliche; quelle a faccia in giù le vede solo chi le possiede o controlla
function viewCard(c, visible) {
  if (!c.faceDown) return c;
  return { iid: c.iid, owner: c.owner, hidden: true, tapped: c.tapped, x: c.x, y: c.y, counters: c.counters, faceDown: c.faceDown, ...(visible ? { name: c.name, img: c.img, peekable: true } : {}) };
}

function buildView(room, viewerId) {
  return {
    code: room.code,
    me: viewerId,
    active: room.active,
    order: room.order,
    log: room.log.slice(-150),
    players: room.order.map((pid) => {
      const p = room.players.get(pid);
      const mine = pid === viewerId;
      const z = p.zones;
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        connected: p.connected,
        life: p.life,
        poison: p.poison,
        cmdDmg: p.cmdDmg,
        handRevealed: p.handRevealed,
        hasDeck: !!p.deck,
        mulligans: p.mulligans,
        libraryCount: z.library.length,
        handCount: z.hand.length,
        peek: mine && p.peek ? z.library.slice(0, p.peek === 'all' ? undefined : p.peek) : null,
        peekMode: mine ? p.peek : null,
        hand: mine || p.handRevealed ? z.hand : null,
        battlefield: z.battlefield.map((c) => viewCard(c, c.owner === viewerId || pid === viewerId)),
        graveyard: z.graveyard,
        exile: z.exile.map((c) => viewCard(c, c.owner === viewerId)),
        command: z.command,
      };
    }),
  };
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
const upgrade = (req, socket, head) => {
  if (!auth.isAuthorized(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
};
server.on('upgrade', upgrade);

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  for (const ws of room.sockets) send(ws, { t: 'state', s: buildView(room, ws.pid) });
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (autoplay.isAutoMessage(msg)) return autoplay.handle(ws, msg); // tavoli con regole automatiche

    if (msg.t === 'join') {
      const code = String(msg.room || 'tavolo').trim().toLowerCase().slice(0, 20) || 'tavolo';
      const room = getRoom(code);
      let p = msg.pid && room.players.get(msg.pid);
      if (!p) {
        if (room.players.size >= MAX_PLAYERS) {
          send(ws, { t: 'error', msg: `Il tavolo "${code}" è pieno (max ${MAX_PLAYERS} giocatori).` });
          return;
        }
        p = newPlayer(room, String(msg.name || '').trim());
        log(room, `${p.name} si siede al tavolo`, p.id);
      }
      p.connected = true;
      ws.room = room;
      ws.pid = p.id;
      room.sockets.add(ws);
      send(ws, { t: 'joined', pid: p.id, room: code });
      broadcast(room);
      return;
    }

    const room = ws.room;
    const p = room && room.players.get(ws.pid);
    if (!p || msg.t !== 'act' || !Object.hasOwn(actions, msg.a)) return;
    try {
      await actions[msg.a](room, p, msg, ws);
    } catch (e) {
      console.error(e);
      send(ws, { t: 'error', msg: 'Errore: ' + e.message });
    }
    if (msg.a === 'leave') {
      room.sockets.delete(ws);
      ws.room = null;
      send(ws, { t: 'left' });
    }
    broadcast(room);
  });

  ws.on('close', () => {
    autoplay.disconnect(ws);
    const room = ws.room;
    if (!room) return;
    room.sockets.delete(ws);
    const p = room.players.get(ws.pid);
    if (p && ![...room.sockets].some((s) => s.pid === p.id)) {
      p.connected = false;
      broadcast(room);
    }
  });
});

const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);

// Se in certs/ ci sono cert.pem e key.pem si avvia anche HTTPS, con lo stesso sito e lo stesso WebSocket
let secure = null;
const certFile = path.join(CERT_DIR, 'cert.pem');
const keyFile = path.join(CERT_DIR, 'key.pem');
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  secure = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, server.listeners('request')[0]);
  secure.on('upgrade', upgrade);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nTavolo Commander avviato!');
  console.log(`  Su questo computer:      http://localhost:${PORT}  (installabile come app)`);
  for (const ip of ips) console.log(`  Dagli altri dispositivi: http://${ip}:${PORT}`);
  if (secure) {
    secure.listen(HTTPS_PORT, '0.0.0.0', () => {
      for (const ip of ips) console.log(`  In HTTPS (app sui telefoni): https://${ip}:${HTTPS_PORT}`);
    });
  } else {
    console.log('  Per installare l\'app sui telefoni serve HTTPS: vedi "App installabile" nel README.');
  }
  if (GENERATED_PASSWORD) console.log(`  Password di questa partita (generata ora): ${PASSWORD}`);
  else console.log(auth.enabled ? '  Accesso protetto da password (TAVOLO_PASSWORD).' : '  Accesso libero: per chiedere una password avvia con TAVOLO_PASSWORD=...');
  console.log('\nPremi Ctrl+C per fermare il server.\n');
  if (USE_TAILSCALE) tailscale.start(PORT, { funnel: FUNNEL, password: PASSWORD }).then((info) => { publicAccess = info; });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (USE_TAILSCALE) await tailscale.stop(FUNNEL);
    process.exit(0);
  });
}
