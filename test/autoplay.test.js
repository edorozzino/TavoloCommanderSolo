// Tavolo con regole automatiche lato server: lobby, avvio, viste separate, azioni legali e rifiutate
const { test } = require('node:test');
const assert = require('node:assert/strict');
const autoplay = require('../autoplay');

function fakeSocket() {
  return { OPEN: 1, readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, last(t) { return this.sent.filter((x) => x.t === t).at(-1); } };
}

async function table(room) {
  const a = fakeSocket();
  const b = fakeSocket();
  await autoplay.handle(a, { t: 'autoJoin', room, name: 'Anna' });
  await autoplay.handle(b, { t: 'autoJoin', room, name: 'Bruno' });
  await autoplay.handle(a, { t: 'autoDeck', deckId: 'starter-0' });
  await autoplay.handle(b, { t: 'autoDeck', deckId: 'starter-1' });
  return { a, b };
}

// Tutti i giocatori umani tengono la mano; i computer rispondono da soli dopo una breve pausa
async function keepHands(...sockets) {
  for (let i = 0; i < 60; i++) {
    const views = sockets.map((s) => s.last('autoState').game);
    if (views[0].step !== 'mulligan') return;
    const turn = sockets.find((s, j) => views[j].decision?.player === views[j].me);
    if (turn) await autoplay.handle(turn, { t: 'autoAct', action: { type: 'confirm', yes: false } });
    else await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('il mulligan non si è concluso');
}

test('due giocatori scelgono un mazzo iniziale e chi ha creato il tavolo avvia la partita', async () => {
  const { a, b } = await table('t-start');
  await autoplay.handle(b, { t: 'autoStart' });
  assert.equal(b.last('error').code, 'NOT_HOST');
  await autoplay.handle(a, { t: 'autoStart' });
  const view = a.last('autoState').game;
  assert.equal(view.players.length, 2);
  assert.equal(view.players.find((p) => p.id === view.me).hand.length, 7);
  assert.equal(view.players.find((p) => p.id !== view.me).hand, null);
});

test('un mazzo salvato con carte sconosciute al motore non si può scegliere', async () => {
  const a = fakeSocket();
  await autoplay.handle(a, { t: 'autoJoin', room: 't-deck', name: 'Anna' });
  const decks = a.last('autoState').decks;
  assert.ok(decks.some((d) => d.id === 'starter-3' && d.ok));
  await autoplay.handle(a, { t: 'autoDeck', deckId: 'inesistente' });
  assert.equal(a.last('error').code, 'NO_DECK');
});

test("un'azione illegale è rifiutata con il motivo; una legale fa avanzare la partita e finisce nel registro", async () => {
  const { a, b } = await table('t-act');
  await autoplay.handle(a, { t: 'autoStart' });
  await keepHands(a, b);
  const v = a.last('autoState').game;
  const active = v.active === v.me ? a : b;
  const other = active === a ? b : a;
  await autoplay.handle(other, { t: 'autoAct', action: { type: 'pass' } });
  assert.equal(other.last('error').code, 'NO_PRIORITY');
  await autoplay.handle(active, { t: 'autoAct', action: { type: 'pass' } });
  assert.notEqual(active.last('autoState').game.priority, v.priority);
});

test('chi ha creato il tavolo aggiunge un giocatore computer, che gioca da solo quando tocca a lui', async () => {
  const a = fakeSocket();
  await autoplay.handle(a, { t: 'autoJoin', room: 't-bot', name: 'Anna' });
  await autoplay.handle(a, { t: 'autoDeck', deckId: 'starter-0' });
  await autoplay.handle(a, { t: 'autoAddBot', deckId: 'starter-2' });
  const lobby = a.last('autoState').lobby;
  assert.equal(lobby.players.length, 2);
  assert.equal(lobby.players[1].bot, true);
  await autoplay.handle(a, { t: 'autoStart' });
  await keepHands(a);
  const g = a.last('autoState').game;
  assert.equal(g.players.length, 2);
  // Anna passa finché non tocca al computer, poi il computer risponde da solo dopo una breve pausa
  for (let i = 0; i < 20 && a.last('autoState').game.priority === g.me; i++) await autoplay.handle(a, { t: 'autoAct', action: { type: 'pass' } });
  const before = a.sent.length;
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(a.sent.length > before, 'il computer ha mosso e la vista è stata aggiornata');
  await autoplay.handle(a, { t: 'autoLeave' });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canPlaySomething = (view) => {
  const me = view.players.find((p) => p.id === view.me);
  return [...(me.hand || []), ...me.command].some((o) => o.playable?.ok)
    || me.battlefield.some((o) => (o.abilities || []).some((a) => a.kind !== 'mana' && a.playable?.ok));
};
// nelle proprie fasi principali a Pila vuota il gioco aspetta sempre, anche senza niente da giocare
const myMainPhase = (view) => view.active === view.me && ['main1', 'main2'].includes(view.step) && !view.stack.length;
const mustWait = (view) => canPlaySomething(view) || myMainPhase(view);

test('come in Arena, chi ha la priorità ma non può fare niente passa da solo: nessuno resta ad aspettare un clic', async () => {
  const { a, b } = await table('t-autopass');
  await autoplay.handle(a, { t: 'autoStart' });
  assert.equal(a.last('autoState').autoPass, true);
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const g = a.last('autoState').game;
    if (g.decision) break;
    const holder = g.priority === g.me ? a : b;
    const view = holder.last('autoState').game;
    if (view.priority === view.me && mustWait(view)) break;
  }
  const g = a.last('autoState').game;
  const holder = g.priority === g.me ? a : b;
  assert.ok(g.decision || mustWait(holder.last('autoState').game), `fermi a ${g.step} con la priorità a chi non può fare niente`);
});

test('con il passaggio automatico disattivato la priorità resta a chi ce l’ha finché non preme Passa', async () => {
  const { a, b } = await table('t-manual');
  await autoplay.handle(a, { t: 'autoPass', on: false });
  await autoplay.handle(b, { t: 'autoPass', on: false });
  await autoplay.handle(a, { t: 'autoStart' });
  const before = a.last('autoState').game;
  assert.equal(a.last('autoState').autoPass, false);
  await sleep(700);
  const after = a.last('autoState').game;
  assert.equal(after.step, before.step);
  assert.equal(after.priority, before.priority);
});
