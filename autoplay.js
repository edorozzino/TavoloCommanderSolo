// Tavoli con regole automatiche: il motore applica le regole, il server inoltra le azioni e invia a ognuno la sua vista.
const crypto = require('crypto');
const { createGame } = require('./engine');
const { buildView } = require('./engine/view');
const { getCard } = require('./engine/cards');
const { RuleError } = require('./engine/errors');
const { STARTER_DECKS } = require('./engine/decks');
const { lookupCards } = require('./scryfall');
const decks = require('./decks');
const lessons = require('./lessons');
const { botMove } = require('./engine/bot');

const rooms = new Map();
const id = () => crypto.randomBytes(6).toString('hex');
const MAX_PLAYERS = 4;

const STEP_NAMES = {
  untap: 'stap', upkeep: 'mantenimento', draw: 'acquisizione', main1: 'prima fase principale', beginCombat: 'inizio combattimento',
  declareAttackers: 'dichiarazione attaccanti', declareBlockers: 'dichiarazione bloccanti', firstStrikeDamage: 'danno (attacco improvviso)',
  combatDamage: 'danno da combattimento', endCombat: 'fine combattimento', main2: 'seconda fase principale', end: 'finale', cleanup: 'cancellazione',
};
const ZONE_NAMES = { hand: 'in mano', battlefield: 'sul campo', graveyard: 'nel cimitero', exile: 'in esilio', command: 'nella zona di comando', library: 'nel grimorio', stack: 'sulla Pila' };

// Mazzi disponibili: i mazzi iniziali e i mazzi salvati composti solo da carte che il motore conosce
function deckChoices() {
  const known = (name) => { try { getCard(name); return true; } catch { return false; } };
  const starters = STARTER_DECKS.map((d, i) => ({ id: `starter-${i}`, name: d.name, commander: d.commander, ok: true }));
  const saved = decks.list().map((d) => {
    const full = decks.get(d.id);
    const names = [...full.commanders, ...full.cards.map((e) => e.name)];
    const unknown = names.filter((n) => !known(n));
    return { id: d.id, name: d.name, commander: full.commanders.join(' + '), ok: unknown.length === 0 && full.commanders.length > 0, unknown: unknown.slice(0, 5), unknownCount: unknown.length };
  });
  return [...starters, ...saved];
}

function deckContents(deckId) {
  if (deckId.startsWith('starter-')) {
    const d = STARTER_DECKS[Number(deckId.slice(8))];
    return d && { commanders: [d.commander], cards: d.cards };
  }
  const d = decks.get(deckId);
  return d && { commanders: d.commanders, cards: d.cards };
}

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { code, players: new Map(), order: [], host: null, game: null, log: [], sockets: new Set(), seen: 0, images: {}, arts: {}, artists: {} });
  return rooms.get(code);
}

const nameOf = (room, pid) => room.players.get(pid)?.name || pid;
function log(room, text) {
  room.log.push({ ts: Date.now(), text });
  if (room.log.length > 300) room.log.shift();
}

// Racconta in italiano gli eventi del motore non ancora registrati
function narrate(room) {
  const g = room.game;
  for (; room.seen < g.events.length; room.seen++) {
    const e = g.events[room.seen];
    if (e.type === 'move') {
      if (e.to === 'stack' && !e.ability) { log(room, `${nameOf(room, e.owner)} lancia ${e.name}`); continue; }
      if (e.ability || e.to === 'stack' || (e.from === 'library' && e.to === 'hand') || (e.from === 'hand' && e.to === 'battlefield')) continue;
      if (e.from === 'stack' && e.to === 'battlefield') { log(room, `${e.name} si risolve ed entra sul campo`); continue; }
      log(room, `${e.name} (${nameOf(room, e.owner)}) va ${ZONE_NAMES[e.to] || e.to}`);
    } else if (e.type === 'combatDamage') {
      log(room, `${e.name} infligge ${e.amount} danni a ${e.player ? nameOf(room, e.player) : e.target}`);
    } else if (e.type === 'lose') {
      log(room, `${nameOf(room, e.player)} ha perso la partita`);
    } else if (e.type === 'fizzle') {
      log(room, 'Una magia o abilità non si risolve: il suo bersaglio non è più valido');
    } else if (e.type === 'reveal') {
      log(room, `${nameOf(room, e.player)} rivela delle carte`);
    }
  }
}

function describeAction(room, pid, a) {
  const g = room.game;
  const obj = (oid) => g.object(oid)?.name || 'una carta';
  switch (a.type) {
    case 'activate': return `${nameOf(room, pid)} attiva un'abilità di ${obj(a.object)}`;
    case 'playLand': return `${nameOf(room, pid)} gioca ${obj(a.object)}`;
    case 'declareAttackers': return a.attackers?.length
      ? `${nameOf(room, pid)} attacca con ${a.attackers.map((x) => `${obj(x.object)} → ${nameOf(room, x.defender)}`).join(', ')}`
      : `${nameOf(room, pid)} non attacca`;
    case 'declareBlockers': return a.blocks?.length
      ? `${nameOf(room, pid)} blocca: ${a.blocks.map((x) => `${obj(x.blocker)} blocca ${obj(x.attacker)}`).join(', ')}`
      : `${nameOf(room, pid)} non blocca`;
    default: return null;
  }
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  const names = Object.fromEntries([...room.players.values()].map((p) => [p.id, p.name]));
  const lobby = {
    host: room.host,
    started: !!room.game,
    players: room.order.map((pid) => {
      const p = room.players.get(pid);
      return { id: pid, name: p.name, deck: p.deckId, deckName: p.deckName, connected: p.connected, bot: !!p.isBot };
    }),
  };
  for (const ws of room.sockets) {
    const msg = { t: 'autoState', room: room.code, me: ws.pid, lobby, log: room.log.slice(-120), autoPass: !room.lesson && room.players.get(ws.pid)?.autoPass !== false };
    if (room.lesson) msg.lesson = lessons.lessonStatus(room.lesson);
    if (room.game) {
      msg.game = buildView(room.game, ws.pid, { names, images: room.images, arts: room.arts, artists: room.artists });
      msg.stepName = STEP_NAMES[room.game.step];
    } else {
      msg.decks = deckChoices();
    }
    send(ws, msg);
  }
}

async function start(room) {
  const ready = room.order.filter((pid) => room.players.get(pid).deckId);
  if (ready.length < 2) throw new RuleError('NOT_READY', 'Servono almeno 2 giocatori con un mazzo scelto');
  const seats = ready.map((pid) => {
    const d = deckContents(room.players.get(pid).deckId);
    return { id: pid, commanders: d.commanders, library: d.cards.flatMap((e) => Array(e.count).fill(e.name)) };
  });
  // immagini delle carte da Scryfall (dalla cache se già viste)
  const names = [...new Set(seats.flatMap((s) => [...s.commanders, ...s.library]))];
  try {
    const { found } = await lookupCards(names);
    for (const [n, info] of found) { room.images[n] = info.img; room.arts[n] = info.art; room.artists[n] = info.artist; }
  } catch { /* senza internet si gioca con le carte di solo testo */ }
  room.game = createGame({ seed: crypto.randomInt(1, 2 ** 31), players: seats });
  room.seen = room.game.events.length;
  log(room, `La partita comincia: ${seats.map((s) => nameOf(room, s.id)).join(', ')}. Tocca a ${nameOf(room, room.game.active)}.`);
}

async function handle(ws, msg) {
  if (msg.t === 'lessonList') {
    return send(ws, { t: 'autoLessons', lessons: lessons.LESSONS.map((l) => ({ id: l.id, n: l.n, title: l.title, goal: l.goal })) });
  }
  if (msg.t === 'lessonStart') { // ogni lezione è una stanza privata: tu contro il Maestro
    let session;
    try {
      session = lessons.startLesson(String(msg.id));
    } catch (e) {
      return send(ws, { t: 'error', msg: e.message });
    }
    if (ws.autoRoom) ws.autoRoom.sockets.delete(ws);
    const room = getRoom(`lezione-${id()}`);
    room.lesson = session;
    room.game = session.game;
    room.seen = session.game.events.length;
    room.players.set(lessons.YOU, { id: lessons.YOU, name: String(msg.name || 'Allievo').slice(0, 24), connected: true });
    room.players.set(lessons.MAESTRO, { id: lessons.MAESTRO, name: 'Maestro', connected: true });
    room.order = [lessons.YOU, lessons.MAESTRO];
    room.host = lessons.YOU;
    const names = [...new Set([...session.game.objects.values()].map((o) => o.name))];
    try {
      const { found } = await lookupCards(names.concat(lessons.LESSON_CARDS || []));
      for (const [n, info] of found) { room.images[n] = info.img; room.arts[n] = info.art; room.artists[n] = info.artist; }
    } catch { /* si gioca anche senza immagini */ }
    log(room, `Lezione ${session.lesson.n}: ${session.lesson.title}. Obiettivo: ${session.lesson.goal}`);
    ws.autoRoom = room;
    ws.pid = lessons.YOU;
    room.sockets.add(ws);
    send(ws, { t: 'autoJoined', pid: lessons.YOU, room: room.code, lesson: true });
    return broadcast(room);
  }
  if (msg.t === 'autoJoin') {
    const code = String(msg.room || 'tavolo').trim().toLowerCase().slice(0, 20) || 'tavolo';
    const room = getRoom(code);
    let p = msg.pid && room.players.get(msg.pid);
    if (!p) {
      if (room.game) return send(ws, { t: 'error', msg: 'La partita su questo tavolo è già iniziata.' });
      if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: `Il tavolo è pieno (max ${MAX_PLAYERS} giocatori).` });
      p = { id: id(), name: String(msg.name || 'Giocatore').trim().slice(0, 24) || 'Giocatore', deckId: null, deckName: null, connected: true };
      room.players.set(p.id, p);
      room.order.push(p.id);
      if (!room.host) room.host = p.id;
      log(room, `${p.name} si siede al tavolo`);
    }
    p.connected = true;
    ws.autoRoom = room;
    ws.pid = p.id;
    room.sockets.add(ws);
    send(ws, { t: 'autoJoined', pid: p.id, room: code });
    return broadcast(room);
  }
  const room = ws.autoRoom;
  const p = room && room.players.get(ws.pid);
  if (!p) return;
  try {
    if (msg.t === 'autoDeck' && !room.game) {
      const choice = deckChoices().find((d) => d.id === msg.deckId);
      if (!choice) throw new RuleError('NO_DECK', 'Mazzo non trovato');
      if (!choice.ok) throw new RuleError('DECK_UNKNOWN', `Il motore non conosce ancora ${choice.unknownCount} carte di questo mazzo (es. ${choice.unknown.join(', ')})`);
      p.deckId = choice.id;
      p.deckName = choice.name;
    } else if (msg.t === 'autoAddBot' && !room.game) {
      if (ws.pid !== room.host) throw new RuleError('NOT_HOST', 'Solo chi ha creato il tavolo può aggiungere giocatori computer');
      if (room.players.size >= MAX_PLAYERS) throw new RuleError('FULL', `Il tavolo è pieno (max ${MAX_PLAYERS} giocatori)`);
      const taken = new Set([...room.players.values()].map((x) => x.deckId));
      const starters = deckChoices().filter((d) => d.id.startsWith('starter-'));
      const deck = starters.find((d) => d.id === msg.deckId) || starters.find((d) => !taken.has(d.id)) || starters[0];
      const n = [...room.players.values()].filter((x) => x.isBot).length + 1;
      const bot = { id: `bot-${id()}`, name: `Computer ${n}`, deckId: deck.id, deckName: deck.name, connected: true, isBot: true };
      room.players.set(bot.id, bot);
      room.order.push(bot.id);
      log(room, `${bot.name} si siede al tavolo con il mazzo ${deck.name}`);
    } else if (msg.t === 'autoRemoveBot' && !room.game) {
      const bot = room.players.get(msg.pid);
      if (ws.pid !== room.host || !bot?.isBot) throw new RuleError('NOT_HOST', 'Solo chi ha creato il tavolo può togliere i giocatori computer');
      room.players.delete(bot.id);
      room.order = room.order.filter((x) => x !== bot.id);
    } else if (msg.t === 'autoPass') {
      p.autoPass = !!msg.on;
    } else if (msg.t === 'autoStart' && !room.game) {
      if (ws.pid !== room.host) throw new RuleError('NOT_HOST', 'Solo chi ha creato il tavolo può avviare la partita');
      await start(room);
    } else if (msg.t === 'autoAct' && room.game) {
      const text = describeAction(room, ws.pid, msg.action || {});
      if (room.lesson) lessons.lessonAct(room.lesson, msg.action || {});
      else room.game.perform(ws.pid, msg.action || {});
      if (text) log(room, text);
      narrate(room);
      if (room.game.winner) log(room, `${nameOf(room, room.game.winner)} vince la partita!`);
    } else if (msg.t === 'autoLeave') {
      room.sockets.delete(ws);
      ws.autoRoom = null;
      if (room.lesson) rooms.delete(room.code);
      if (!room.game) {
        room.players.delete(p.id);
        room.order = room.order.filter((x) => x !== p.id);
        if (room.host === p.id) room.host = room.order.find((x) => !room.players.get(x).isBot) || null;
      if (!room.host) rooms.delete(room.code); // restano solo computer: il tavolo si chiude
      }
      send(ws, { t: 'autoLeft' });
    }
  } catch (e) {
    if (!(e instanceof RuleError)) console.error(e);
    send(ws, { t: 'error', msg: e.message, code: e.code });
  }
  broadcast(room);
  scheduleBots(room);
}

// Può fare qualcosa adesso? Una carta da giocare o un'abilità da attivare (le abilità di mana da sole non contano)
function canAct(g, pid) {
  const me = buildView(g, pid).players.find((p) => p.id === pid);
  if ([...(me.hand || []), ...me.command].some((o) => o.playable?.ok)) return true;
  return me.battlefield.some((o) => (o.abilities || []).some((a) => a.kind !== 'mana' && a.playable?.ok));
}

// Come in MTG Arena: chi ha la priorità ma non può fare niente passa da solo, così nessuno resta ad aspettare un clic
// (si disattiva dal gioco; nelle lezioni dell'Accademia si passa sempre a mano).
// Nelle proprie fasi principali a Pila vuota ci si ferma sempre: è lì che si decide il turno
function autoPasses(room, pid) {
  const p = room.players.get(pid);
  const g = room.game;
  const myMain = g.active === pid && (g.step === 'main1' || g.step === 'main2') && g.stack.length === 0;
  return !room.lesson && p && !p.isBot && p.autoPass !== false && !g.decision && !myMain && !canAct(g, pid);
}

// I giocatori computer muovono uno alla volta, con una breve pausa perché si veda che cosa fanno
function scheduleBots(room) {
  if (room.botTimer || !room.game || room.game.winner) return;
  const g = room.game;
  const who = g.decision ? g.decision.player : g.priority;
  if (who && autoPasses(room, who)) {
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (!rooms.has(room.code) || room.game !== g || g.winner) return;
      if (g.priority === who && autoPasses(room, who)) {
        g.perform(who, { type: 'pass' });
        narrate(room);
        broadcast(room);
      }
      scheduleBots(room);
    }, 350);
    return;
  }
  if (!who || !room.players.get(who)?.isBot) return;
  const move = botMove(g, who);
  const delay = move.type === 'pass' ? 150 : 700;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!rooms.has(room.code) || room.game !== g || g.winner) return;
    const current = g.decision ? g.decision.player : g.priority;
    if (current !== who) return scheduleBots(room);
    const next = botMove(g, who); // lo stato potrebbe essere cambiato durante l'attesa
    const text = describeAction(room, who, next);
    try {
      g.perform(who, next);
    } catch (e) {
      if (!(e instanceof RuleError)) console.error(e);
      if (!g.decision) g.perform(who, { type: 'pass' });
    }
    if (text) log(room, text);
    narrate(room);
    if (g.winner) log(room, `${nameOf(room, g.winner)} vince la partita!`);
    broadcast(room);
    scheduleBots(room);
  }, delay);
}

function disconnect(ws) {
  const room = ws.autoRoom;
  if (!room) return;
  room.sockets.delete(ws);
  const p = room.players.get(ws.pid);
  if (p && ![...room.sockets].some((s) => s.pid === p.id)) {
    p.connected = false;
    broadcast(room);
  }
}

module.exports = { handle, disconnect, isAutoMessage: (msg) => /^(auto|lesson)/.test(String(msg.t || '')) };
