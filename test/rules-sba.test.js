// CR 704.5j (regola delle leggende), 704.5q (segnalini opposti), 800.4a (uscita dalla partita), 903.9b (comandante in mano o nel grimorio)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commanderGame, advanceTo } = require('./helpers');

const LEGEND = 'Krenko, Mob Boss';
const start = (opts) => { const g = commanderGame(opts); advanceTo(g, 'main1'); return g; };
const named = (g, pid, name) => g.battlefield().filter((o) => o.controller === pid && o.name === name);

test('due leggende omonime dello stesso giocatore: ne sceglie una e l\'altra va nel cimitero (CR 704.5j)', () => {
  const g = start();
  const first = g.setup.putOnBattlefield('A', LEGEND);
  const second = g.setup.putOnBattlefield('A', LEGEND);
  g.perform('A', { type: 'pass' });
  assert.equal(g.decision.type, 'chooseCards');
  assert.equal(g.decision.player, 'A');
  g.perform('A', { type: 'chooseCards', objects: [second] });
  assert.deepEqual(named(g, 'A', LEGEND).map((o) => o.id), [second]);
  assert.equal(g.object(first), undefined);
  assert.equal(g.zone('A', 'graveyard').length, 1);
  assert.equal(g.priority, 'B');
});

test('la stessa leggenda sotto il controllo di giocatori diversi non fa scattare la regola (CR 704.5j)', () => {
  const g = start();
  g.setup.putOnBattlefield('A', LEGEND);
  g.setup.putOnBattlefield('B', LEGEND);
  g.perform('A', { type: 'pass' });
  assert.equal(g.decision, null);
  assert.equal(g.priority, 'B');
});

test('segnalini +1/+1 e -1/-1 sullo stesso permanente si annullano a coppie (CR 704.5q)', () => {
  const g = start();
  const o = g.object(g.setup.putOnBattlefield('A', 'Grizzly Bears'));
  Object.assign(o.counters, { '+1/+1': 3, '-1/-1': 1 });
  g.perform('A', { type: 'pass' });
  assert.deepEqual(g.object(o.id).counters, { '+1/+1': 2 });
});

test('chi esce dalla partita perde il controllo dei permanenti altrui (CR 800.4a)', () => {
  const g = start();
  const id = g.setup.putOnBattlefield('B', 'Grizzly Bears');
  g.setup.gainControl(id, 'A');
  g.eliminate('A');
  assert.equal(g.object(id).controller, 'B');
  assert.equal(g.object(id).zone, 'battlefield');
});

for (const [zone, opts] of [['hand', {}], ['library', {}], ['library', { top: true }]]) {
  test(`il comandante che andrebbe in ${zone}${opts.top ? ' (in cima)' : ''} torna nella zona di comando (CR 903.9b)`, () => {
    const g = start();
    const size = g.zone('A', 'library').length;
    const commander = g.zone('A', 'command')[0].id;
    const id = g.setup.moveTo(commander, 'battlefield');
    const back = g.move(id, zone, opts);
    assert.equal(g.object(back).zone, 'command');
    assert.equal(g.zone('A', 'library').length, size);
  });
}

test('con il comando manuale il comandante può comunque andare in mano (CR 903.9b è facoltativa)', () => {
  const g = start();
  const id = g.setup.moveTo(g.zone('A', 'command')[0].id, 'battlefield');
  assert.equal(g.object(g.move(id, 'hand', { manual: true })).zone, 'hand');
});
