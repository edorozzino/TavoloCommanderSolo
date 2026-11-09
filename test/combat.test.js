// CR 506-511: combattimento; CR 302.6: debolezza da evocazione; CR 702: keyword di combattimento
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commanderGame, advanceTo, attackWith, passAll } = require('./helpers');

const on = (g, pid, name, opts) => g.setup.putOnBattlefield(pid, name, opts);
const declareBlocks = (g, pid, blocks) => {
  advanceTo(g, 'declareBlockers');
  g.perform(pid, { type: 'declareBlockers', blocks: blocks.map(([blocker, attacker]) => ({ blocker, attacker })) });
};
const toDamage = (g) => advanceTo(g, 'endCombat');
const alive = (g, id) => g.object(id)?.zone === 'battlefield';

test('una creatura entrata in questo turno non può attaccare (CR 302.6)', () => {
  const g = commanderGame();
  const bears = on(g, 'A', 'Grizzly Bears', { sick: true });
  advanceTo(g, 'declareAttackers');
  assert.throws(() => g.perform('A', { type: 'declareAttackers', attackers: [{ object: bears, defender: 'B' }] }), (e) => e.code === 'SUMMONING_SICK');
});

test('con Rapidità una creatura attacca subito (CR 702.10)', () => {
  const g = commanderGame();
  on(g, 'A', 'Goblin Guide', { sick: true });
  attackWith(g, [[g.zone('A', 'battlefield')[0].id, 'B']]);
  toDamage(g);
  assert.equal(g.player('B').life, 38);
});

test('una creatura non bloccata infligge danno pari alla sua forza al difensore (CR 510.1a)', () => {
  const g = commanderGame();
  const bears = on(g, 'A', 'Grizzly Bears');
  attackWith(g, [[bears, 'B']]);
  toDamage(g);
  assert.equal(g.player('B').life, 38);
  assert.equal(g.player('C').life, 40);
});

test('attaccare tappa la creatura (CR 508.1f), ma non con Cautela (CR 702.20)', () => {
  const g = commanderGame();
  const bears = on(g, 'A', 'Grizzly Bears');
  const angel = on(g, 'A', 'Serra Angel');
  attackWith(g, [[bears, 'B'], [angel, 'B']]);
  assert.equal(g.object(bears).tapped, true);
  assert.equal(g.object(angel).tapped, false);
});

test('una creatura con Difensore non può attaccare (CR 702.3b)', () => {
  const g = commanderGame();
  const wall = on(g, 'A', 'Wall of Wood');
  advanceTo(g, 'declareAttackers');
  assert.throws(() => g.perform('A', { type: 'declareAttackers', attackers: [{ object: wall, defender: 'B' }] }), (e) => e.code === 'CANT_ATTACK');
});

test('in multiplayer si possono attaccare avversari diversi nello stesso combattimento (CR 506.2)', () => {
  const g = commanderGame();
  attackWith(g, [[on(g, 'A', 'Grizzly Bears'), 'B'], [on(g, 'A', 'Serra Angel'), 'C']]);
  toDamage(g);
  assert.equal(g.player('B').life, 38);
  assert.equal(g.player('C').life, 36);
});

test('non si può attaccare sé stessi', () => {
  const g = commanderGame();
  const bears = on(g, 'A', 'Grizzly Bears');
  advanceTo(g, 'declareAttackers');
  assert.throws(() => g.perform('A', { type: 'declareAttackers', attackers: [{ object: bears, defender: 'A' }] }), (e) => e.code === 'INVALID_DEFENDER');
});

test('una creatura bloccata colpisce il bloccante e non il giocatore: due orsi si eliminano a vicenda', () => {
  const g = commanderGame();
  const a = on(g, 'A', 'Grizzly Bears');
  const b = on(g, 'B', 'Grizzly Bears');
  attackWith(g, [[a, 'B']]);
  declareBlocks(g, 'B', [[b, a]]);
  toDamage(g);
  assert.equal(g.player('B').life, 40);
  assert.equal(alive(g, a), false);
  assert.equal(alive(g, b), false);
});

test('una creatura con Volare può essere bloccata solo da creature con Volare o Raggiungere (CR 702.9b, 702.17b)', () => {
  const g = commanderGame();
  const angel = on(g, 'A', 'Serra Angel');
  const bears = on(g, 'B', 'Grizzly Bears');
  const spider = on(g, 'B', 'Giant Spider');
  attackWith(g, [[angel, 'B']]);
  advanceTo(g, 'declareBlockers');
  assert.throws(() => g.perform('B', { type: 'declareBlockers', blocks: [{ blocker: bears, attacker: angel }] }), (e) => e.code === 'INVALID_BLOCK');
  g.perform('B', { type: 'declareBlockers', blocks: [{ blocker: spider, attacker: angel }] });
  toDamage(g);
  assert.equal(g.player('B').life, 40);
});

test('una creatura con Minacciare deve essere bloccata da almeno due creature (CR 702.111b)', () => {
  const g = commanderGame();
  const brute = on(g, 'A', 'Boggart Brute');
  const [b1, b2] = [on(g, 'B', 'Grizzly Bears'), on(g, 'B', 'Grizzly Bears')];
  attackWith(g, [[brute, 'B']]);
  advanceTo(g, 'declareBlockers');
  assert.throws(() => g.perform('B', { type: 'declareBlockers', blocks: [{ blocker: b1, attacker: brute }] }), (e) => e.code === 'INVALID_BLOCK');
  g.perform('B', { type: 'declareBlockers', blocks: [{ blocker: b1, attacker: brute }, { blocker: b2, attacker: brute }] });
  toDamage(g);
  assert.equal(alive(g, brute), false);
});

test('una creatura tappata non può bloccare (CR 509.1a)', () => {
  const g = commanderGame();
  const a = on(g, 'A', 'Grizzly Bears');
  const b = on(g, 'B', 'Grizzly Bears', { tapped: true });
  attackWith(g, [[a, 'B']]);
  advanceTo(g, 'declareBlockers');
  assert.equal(g.decision, null); // B non ha bloccanti disponibili: nessuna scelta da fare
  toDamage(g);
  assert.equal(g.player('B').life, 38);
  assert.equal(alive(g, b), true);
});

test('con Travolgere il danno oltre quello letale va al giocatore (CR 702.19b)', () => {
  const g = commanderGame();
  const dreadmaw = on(g, 'A', 'Colossal Dreadmaw');
  const bears = on(g, 'B', 'Grizzly Bears');
  attackWith(g, [[dreadmaw, 'B']]);
  declareBlocks(g, 'B', [[bears, dreadmaw]]);
  toDamage(g);
  assert.equal(g.player('B').life, 36);
  assert.equal(alive(g, bears), false);
});

test('senza Travolgere una creatura bloccata non infligge danno al giocatore', () => {
  const g = commanderGame();
  const angel = on(g, 'A', 'Serra Angel');
  const spider = on(g, 'B', 'Giant Spider');
  attackWith(g, [[angel, 'B']]);
  declareBlocks(g, 'B', [[spider, angel]]);
  toDamage(g);
  assert.equal(g.player('B').life, 40);
  assert.equal(alive(g, spider), false); // 4 danni su costituzione 4: muore
});

test('Tocco letale: qualsiasi danno a una creatura la distrugge (CR 702.2b, 704.5h)', () => {
  const g = commanderGame();
  const dreadmaw = on(g, 'A', 'Colossal Dreadmaw');
  const rats = on(g, 'B', 'Typhoid Rats');
  attackWith(g, [[dreadmaw, 'B']]);
  declareBlocks(g, 'B', [[rats, dreadmaw]]);
  toDamage(g);
  assert.equal(alive(g, dreadmaw), false);
  assert.equal(g.player('B').life, 35); // Travolgere: 1 letale ai ratti, 5 al giocatore
});

test('Legame vitale: il controllore guadagna tanta vita quanto il danno inflitto (CR 702.15b)', () => {
  const g = commanderGame();
  attackWith(g, [[on(g, 'A', 'Vampire Nighthawk'), 'B']]);
  toDamage(g);
  assert.equal(g.player('B').life, 38);
  assert.equal(g.player('A').life, 42);
});

test('Attacco improvviso: chi colpisce per primo elimina il bloccante prima che risponda (CR 702.7b)', () => {
  const g = commanderGame();
  const knight = on(g, 'A', 'Youthful Knight');
  const bears = on(g, 'B', 'Grizzly Bears');
  attackWith(g, [[knight, 'B']]);
  declareBlocks(g, 'B', [[bears, knight]]);
  toDamage(g);
  assert.equal(alive(g, bears), false);
  assert.equal(alive(g, knight), true);
});

test('con Attacco improvviso nel combattimento c\'è un passo di danno in più (CR 510.4)', () => {
  const g = commanderGame();
  attackWith(g, [[on(g, 'A', 'Youthful Knight'), 'B']]);
  advanceTo(g, 'firstStrikeDamage');
  assert.equal(g.player('B').life, 38);
});

test('Doppio attacco: la creatura infligge danno in entrambi i passi (CR 702.4b)', () => {
  const g = commanderGame();
  attackWith(g, [[on(g, 'A', 'Fencing Ace'), 'B']]);
  toDamage(g);
  assert.equal(g.player('B').life, 38);
});

test('Indistruttibile: il danno letale non distrugge la creatura (CR 702.12b)', () => {
  const g = commanderGame();
  const bears = on(g, 'A', 'Grizzly Bears');
  const myr = on(g, 'B', 'Darksteel Myr');
  attackWith(g, [[bears, 'B']]);
  declareBlocks(g, 'B', [[myr, bears]]);
  toDamage(g);
  assert.equal(alive(g, myr), true);
});

test('il danno sulle creature si rimuove nella sottofase di cancellazione (CR 514.2)', () => {
  const g = commanderGame();
  const bears = on(g, 'A', 'Grizzly Bears');
  const spider = on(g, 'B', 'Giant Spider');
  attackWith(g, [[bears, 'B']]);
  declareBlocks(g, 'B', [[spider, bears]]);
  toDamage(g);
  assert.equal(g.object(spider).damage, 2);
  advanceTo(g, 'upkeep', 2);
  assert.equal(g.object(spider).damage, 0);
});
