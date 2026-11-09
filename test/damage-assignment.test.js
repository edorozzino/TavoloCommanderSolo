// CR 510.1c, 510.1e: chi attacca divide il danno tra più bloccanti
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commanderGame, advanceTo, attackWith } = require('./helpers');
const { botMove } = require('../engine/bot');

const on = (g, pid, name) => g.setup.putOnBattlefield(pid, name);
function blocked(attackerName, blockerNames, counters = 0) {
  const g = commanderGame();
  g.askDamage = true;
  advanceTo(g, 'main1');
  const att = on(g, 'A', attackerName);
  if (counters) g.object(att).counters['+1/+1'] = counters;
  const blockers = blockerNames.map((n) => on(g, 'B', n));
  attackWith(g, [[att, 'B']]);
  advanceTo(g, 'declareBlockers');
  g.perform('B', { type: 'declareBlockers', blocks: blockers.map((blocker) => ({ blocker, attacker: att })) });
  while (g.step !== 'combatDamage' && g.step !== 'firstStrikeDamage') g.perform(g.priority, { type: 'pass' });
  return { g, att, blockers };
}

test('la forza non basta per tutti: chi attacca sceglie come dividere (CR 510.1c)', () => {
  const { g, blockers: [x, y] } = blocked('Grizzly Bears', ['Grizzly Bears', 'Grizzly Bears']);
  assert.equal(g.decision.type, 'assignDamage');
  assert.equal(g.decision.player, 'A');
  assert.equal(g.decision.power, 2);
  g.perform('A', { type: 'assignDamage', assignment: { [y]: 2 } });
  assert.equal(g.object(x).zone, 'battlefield');
  assert.equal(g.object(y), undefined);
});

test('il danno può essere diviso anche senza essere letale (CR 510.1c)', () => {
  const { g, blockers: [x, y] } = blocked('Grizzly Bears', ['Grizzly Bears', 'Grizzly Bears']);
  g.perform('A', { type: 'assignDamage', assignment: { [x]: 1, [y]: 1 } });
  assert.equal(g.object(x).damage, 1);
  assert.equal(g.object(y).damage, 1);
});

test('una divisione che non somma alla forza è rifiutata e si può rifare (CR 510.1e)', () => {
  const { g, blockers: [x, y] } = blocked('Grizzly Bears', ['Grizzly Bears', 'Grizzly Bears']);
  assert.throws(() => g.perform('A', { type: 'assignDamage', assignment: { [x]: 1 } }));
  assert.throws(() => g.perform('A', { type: 'assignDamage', assignment: { [x]: 3, [y]: -1 } }));
  assert.equal(g.decision.type, 'assignDamage');
});

test('se la forza basta per tutti non si chiede nulla', () => {
  const { g, blockers: [x, y] } = blocked('Grizzly Bears', ['Grizzly Bears', 'Grizzly Bears'], 2);
  assert.equal(g.decision, null);
  assert.equal(g.object(x), undefined);
  assert.equal(g.object(y), undefined);
});

test('con un solo bloccante non si chiede nulla', () => {
  const { g } = blocked('Grizzly Bears', ['Grizzly Bears']);
  assert.equal(g.decision, null);
});

test('dopo la divisione la priorità torna al giocatore attivo', () => {
  const { g, blockers: [x] } = blocked('Grizzly Bears', ['Grizzly Bears', 'Grizzly Bears']);
  g.perform('A', { type: 'assignDamage', assignment: { [x]: 2 } });
  assert.equal(g.priority, 'A');
  assert.equal(g.step, 'combatDamage');
});

test('il computer divide da solo uccidendo prima i più facili', () => {
  const { g, blockers: [x] } = blocked('Grizzly Bears', ['Grizzly Bears', 'Grizzly Bears']);
  g.perform('A', botMove(g, 'A'));
  assert.equal(g.object(x), undefined);
});
