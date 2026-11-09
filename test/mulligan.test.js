// CR 103.5 (mulligan), 103.5c (il primo è gratis in multiplayer)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('../engine');
const { botMove } = require('../engine/bot');

const game = (players) => createGame({
  seed: 7, mulligan: true,
  players: ['A', 'B', 'C', 'D'].slice(0, players).map((id) => ({ id, commanders: ['Krenko, Mob Boss'], library: Array(99).fill('Mountain') })),
});
const decide = (g, pid, yes) => g.perform(pid, { type: 'confirm', yes });
const handSize = (g, pid) => g.zone(pid, 'hand').length;
const bottom = (g, pid, n) => g.perform(pid, { type: 'putBack', objects: g.zone(pid, 'hand').slice(0, n).map((o) => o.id) });

test('senza mulligan la partita comincia dopo le dichiarazioni in ordine di turno (CR 103.5)', () => {
  const g = game(2);
  assert.equal(g.step, 'mulligan');
  assert.equal(g.decision.player, 'A');
  decide(g, 'A', false);
  assert.equal(g.decision.player, 'B');
  decide(g, 'B', false);
  assert.equal(handSize(g, 'A'), 7);
  assert.notEqual(g.step, 'mulligan');
  assert.equal(g.turn, 1);
});

test('in partita a 2 il primo mulligan costa una carta (CR 103.5)', () => {
  const g = game(2);
  decide(g, 'A', true);
  decide(g, 'B', false);
  assert.equal(handSize(g, 'A'), 7);
  assert.equal(g.decision.type, 'putBack');
  const last = g.zone('A', 'hand')[0].cardId;
  bottom(g, 'A', 1);
  assert.equal(handSize(g, 'A'), 6);
  assert.equal(g.zone('A', 'library').at(-1).cardId, last);
  assert.equal(g.decision.player, 'A');
  decide(g, 'A', false);
  assert.notEqual(g.step, 'mulligan');
});

test('in multiplayer il primo mulligan è gratis, il secondo costa una carta (CR 103.5c)', () => {
  const g = game(4);
  for (const p of ['A', 'B', 'C', 'D']) decide(g, p, p === 'A');
  assert.equal(handSize(g, 'A'), 7);
  assert.equal(g.decision.type, 'confirm');
  decide(g, 'A', true);
  assert.equal(g.decision.type, 'putBack');
  assert.equal(g.decision.count, 1);
  bottom(g, 'A', 1);
  assert.equal(handSize(g, 'A'), 6);
  decide(g, 'A', false);
  assert.notEqual(g.step, 'mulligan');
});

test('chi tiene la mano non può più fare mulligan (CR 103.5)', () => {
  const g = game(2);
  decide(g, 'A', false);
  decide(g, 'B', true);
  bottom(g, 'B', 1);
  assert.equal(g.decision.player, 'B');
  assert.throws(() => decide(g, 'A', true));
});

test('si può continuare finché la mano non è a zero, poi basta (CR 103.5)', () => {
  const g = game(2);
  decide(g, 'B' === g.decision.player ? 'B' : 'A', false);
  for (let i = 1; i <= 7; i++) {
    decide(g, 'B', true);
    bottom(g, 'B', i);
    assert.equal(handSize(g, 'B'), 7 - i);
  }
  assert.notEqual(g.step, 'mulligan');
  assert.equal(handSize(g, 'B'), 0);
});

test('il mulligan non rivela le carte nel registro', () => {
  const g = game(2);
  const before = g.events.length;
  decide(g, 'A', true);
  decide(g, 'B', false);
  bottom(g, 'A', 1);
  assert.deepEqual(g.events.slice(before).map((e) => e.type), ['mulligan']);
});

test('il computer tiene una mano giocabile e la partita parte', () => {
  const g = game(4);
  for (let i = 0; i < 40 && g.step === 'mulligan'; i++) g.perform(g.decision.player, botMove(g, g.decision.player));
  assert.notEqual(g.step, 'mulligan');
});

test('senza l\'opzione la partita parte subito (lezioni dell\'Accademia e scenari)', () => {
  const g = createGame({ seed: 7, players: [{ id: 'A', commanders: ['Krenko, Mob Boss'], library: Array(99).fill('Mountain') }, { id: 'B', commanders: ['Krenko, Mob Boss'], library: Array(99).fill('Mountain') }] });
  assert.notEqual(g.step, 'mulligan');
});
