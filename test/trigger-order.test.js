// CR 603.3b (ordine scelto tra i propri inneschi simultanei), 405.2 (Pila)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('../engine');
const { botMove } = require('../engine/bot');
const { buildView } = require('../engine/view');

const LAND = Array(99).fill('Forest');
const seats = ['A', 'B'].map((id) => ({ id, commanders: ['Krenko, Mob Boss'], library: LAND }));
const draw = (g) => ({ kind: 'draw', amount: 1 });
function game(orderTriggers = true) {
  const g = createGame({ seed: 3, orderTriggers, players: seats });
  while (g.step !== 'main1') g.perform(g.priority, { type: 'pass' });
  return g;
}
// Tre inneschi diversi in coda, come se fossero scattati insieme
function fire(g, pid, names) {
  for (const name of names) {
    const id = g.setup.putOnBattlefield(pid, 'Grizzly Bears');
    const o = g.object(id);
    o.name = name;
    g.queueTrigger(o, { kind: 'triggered', effect: draw(g) });
  }
  g.givePriority(g.active);
}

test('con più inneschi diversi il controllore sceglie l\'ordine di risoluzione (CR 603.3b)', () => {
  const g = game();
  fire(g, 'A', ['Primo', 'Secondo', 'Terzo']);
  assert.equal(g.decision.type, 'orderTriggers');
  assert.equal(g.decision.player, 'A');
  g.perform('A', { type: 'orderTriggers', order: [2, 0, 1] });
  assert.equal(g.decision, null);
  assert.deepEqual(g.stack.map((o) => o.name), ['Secondo', 'Primo', 'Terzo']); // l'ultimo elencato è in cima
});

test('inneschi di giocatori diversi: ognuno ordina i suoi, quelli del giocatore attivo restano sotto (CR 603.3b)', () => {
  const g = game();
  for (const [pid, name] of [['A', 'A1'], ['A', 'A2'], ['B', 'B1'], ['B', 'B2']]) {
    const o = g.object(g.setup.putOnBattlefield(pid, 'Grizzly Bears'));
    o.name = name;
    g.queueTrigger(o, { kind: 'triggered', effect: draw(g) });
  }
  g.givePriority(g.active);
  assert.equal(g.decision.player, 'A');
  g.perform('A', { type: 'orderTriggers', order: [0, 1] });
  assert.equal(g.decision.player, 'B');
  g.perform('B', { type: 'orderTriggers', order: [1, 0] });
  assert.deepEqual(g.stack.map((o) => o.name), ['A2', 'A1', 'B1', 'B2']);
});

test('un ordine incompleto o ripetuto viene rifiutato', () => {
  const g = game();
  fire(g, 'A', ['Primo', 'Secondo']);
  assert.throws(() => g.perform('A', { type: 'orderTriggers', order: [0, 0] }));
  assert.throws(() => g.perform('A', { type: 'orderTriggers', order: [0] }));
  assert.equal(g.decision.type, 'orderTriggers');
});

test('inneschi indistinguibili non chiedono nulla', () => {
  const g = game();
  fire(g, 'A', ['Uguale', 'Uguale']);
  assert.equal(g.decision, null);
  assert.equal(g.stack.length, 2);
});

test('il computer ordina da solo', () => {
  const g = game();
  fire(g, 'A', ['Primo', 'Secondo']);
  g.perform('A', botMove(g, 'A'));
  assert.equal(g.stack.length, 2);
});

test('la scelta è visibile solo a chi deve decidere', () => {
  const g = game();
  fire(g, 'A', ['Primo', 'Secondo']);
  assert.deepEqual(buildView(g, 'A').decision.triggers.map((t) => t.name), ['Primo', 'Secondo']);
  assert.equal(buildView(g, 'B').decision.triggers, undefined);
});

test('senza l\'opzione l\'ordine resta automatico', () => {
  const g = game(false);
  fire(g, 'A', ['Primo', 'Secondo']);
  assert.equal(g.decision, null);
  assert.equal(g.stack.length, 2);
});
