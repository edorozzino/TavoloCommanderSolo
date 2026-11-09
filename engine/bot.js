// Avversario computer: regole di buon senso, nessuna ricerca in profondità. Ogni mossa proposta viene prima
// verificata con game.check(), quindi il bot non fa mai azioni illegali: al peggio passa.
const { parseCost, COLORS } = require('./mana');
const F = require('./filters');

const { isType, isCreature } = F;

// Magie che colpiscono anche le creature del bot: solo se gli avversari hanno chiaramente più creature
const BOARD_WIPES = new Set(['Damnation', 'Blasphemous Act', 'Evacuation', 'Living Death', 'All Is Dust', "Nevinyrral's Disk"]);
// Effetti dannosi per il bersaglio: si rivolgono agli avversari
const HARMFUL = new Set(['damage', 'destroy', 'bounce', 'counter', 'mill', 'targetLosesYouGain', 'exileGraveyard', 'poison']);
const MAX_ACTIONS_PER_STEP = 25;
const actionsThisStep = new WeakMap();

const manaValue = (def) => {
  const c = parseCost(def.cost || '');
  return c.generic + COLORS.reduce((n, k) => n + c[k], 0);
};

function value(g, o) {
  if (!o) return 0;
  const creature = o.zone === 'battlefield' && isCreature(o);
  return (creature ? g.power(o) * 2 + g.toughness(o) : 0) + manaValue(o.def) + (o.isCommander ? 6 : 0) + (o.isToken ? -2 : 0);
}

const opponents = (g, pid) => g.players.filter((p) => p !== pid);
const mine = (g, pid) => g.battlefield().filter((o) => o.controller === pid);
const creaturesOf = (g, pid) => mine(g, pid).filter(isCreature);
const lowestLifeOpponent = (g, pid) => opponents(g, pid).sort((a, b) => g.state.get(a).life - g.state.get(b).life)[0];

// ---------- Scelta dei bersagli ----------
function effectOf(effects) {
  return effects.find((e) => e && (e.target || e.targets)) || null;
}

function pickTarget(g, pid, effect, options) {
  if (!options.length) return null;
  const kind = effect?.kind;
  const harmful = HARMFUL.has(kind) || (kind === 'pump' && (effect.power || 0) < 0);
  const obj = (t) => t.object && g.object(t.object);
  const theirs = (t) => (t.player ? t.player !== pid : obj(t) && (obj(t).controller ?? obj(t).owner) !== pid);
  // carte nei cimiteri: rianimare e riprendere le proprie migliori, esiliare quelle avversarie
  if (options.every((t) => obj(t)?.zone === 'graveyard')) {
    const wantOwn = kind === 'reanimate' || kind === 'bounce';
    const pool = options.filter((t) => (obj(t).owner === pid) === wantOwn);
    return (pool.length ? pool : options).sort((a, b) => manaValue(obj(b).def) - manaValue(obj(a).def))[0];
  }
  if (kind === 'counter') return options.find((t) => obj(t)?.controller !== pid) || null;
  if (kind === 'targetDrawsLoses') return options.find((t) => t.player === pid) || options[0];
  if (harmful) {
    const enemy = options.filter(theirs);
    if (!enemy.length) return null;
    if (kind === 'damage') {
      const n = typeof effect.amount === 'number' ? effect.amount : g.count(effect.amount, { controller: pid });
      const killable = enemy.filter((t) => obj(t) && isCreature(obj(t)) && g.toughness(obj(t)) - obj(t).damage <= n);
      if (killable.length) return killable.sort((a, b) => value(g, obj(b)) - value(g, obj(a)))[0];
      const players = enemy.filter((t) => t.player).sort((a, b) => g.state.get(a.player).life - g.state.get(b.player).life);
      return players[0] || null;
    }
    const best = enemy.filter((t) => t.object).sort((a, b) => value(g, obj(b)) - value(g, obj(a)))[0];
    return best || enemy.find((t) => t.player === lowestLifeOpponent(g, pid)) || enemy[0];
  }
  // effetti utili: sulle proprie creature migliori (o su di sé)
  const own = options.filter((t) => !theirs(t));
  if (!own.length) return null;
  return own.sort((a, b) => value(g, obj(b)) - value(g, obj(a)))[0];
}

function chooseSacrifice(g, pid, options) {
  return [...options].sort((a, b) => value(g, g.object(a)) - value(g, g.object(b)))[0];
}

function chooseDiscard(g, pid, count, exclude = []) {
  const hand = g.zone(pid, 'hand').filter((o) => !exclude.includes(o.id));
  const lands = mine(g, pid).filter((o) => isType(o, 'Land')).length;
  // con abbastanza terre si scartano le terre, altrimenti le carte più costose
  const score = (o) => (isType(o, 'Land') ? (lands >= 5 ? -10 : 10) : -manaValue(o.def));
  return hand.sort((a, b) => score(a) - score(b)).slice(0, count).map((o) => o.id);
}

// ---------- Lanciare e attivare ----------
function buildCast(g, pid, o) {
  const def = o.def;
  const action = { type: 'cast', object: o.id, autoPay: true };
  const effects = def.modes ? null : [].concat(def.effect || []);
  const tryEffects = (effs, extra = {}) => {
    const e = effectOf(effs);
    const a = { ...action, ...extra };
    if (e?.targets) {
      a.targets = e.targets.map((kind, i) => pickTarget(g, pid, i === 0 ? { kind: 'pump' } : e, g.targetOptions(kind, pid)));
      if (a.targets.some((t) => !t)) return null;
    } else if (e?.target) {
      const t = pickTarget(g, pid, e, g.targetOptions(e.target, pid));
      if (!t) return null;
      a.targets = [t];
    }
    if (def.additionalCost?.sacrifice) {
      const opts = g.battlefield().filter((x) => F.SACRIFICE[def.additionalCost.sacrifice](g, x, pid, o)).map((x) => x.id);
      const tokens = opts.filter((id) => g.object(id).isToken);
      if (!tokens.length && !isType(o, 'Land')) return null; // sacrifica solo token: mai una carta vera per pagare
      a.sacrifice = [tokens[0]];
    }
    if (def.additionalCost?.discard) a.discard = chooseDiscard(g, pid, def.additionalCost.discard, [o.id]);
    return a;
  };
  if (def.modes) {
    for (let i = 0; i < def.modes.length; i++) {
      const a = tryEffects([def.modes[i]], { mode: i });
      if (a && g.check(pid, a).ok) return a;
    }
    return null;
  }
  return tryEffects(effects);
}

// Quando ha senso lanciare una certa carta
function timingOk(g, pid, o) {
  const def = o.def;
  const kinds = [].concat(def.effect || [], ...(def.modes || [])).map((e) => e?.kind);
  const myMain = g.active === pid && (g.step === 'main1' || g.step === 'main2') && !g.stack.length;
  const inCombat = g.combat && ['declareBlockers', 'combatDamage'].includes(g.step);
  if (BOARD_WIPES.has(def.name)) {
    const theirMax = Math.max(0, ...opponents(g, pid).map((p) => creaturesOf(g, p).length));
    return myMain && theirMax >= creaturesOf(g, pid).length + 2;
  }
  if (kinds.includes('counter')) return g.stack.some((s) => s.controller !== pid && !s.isAbility);
  if (kinds.includes('addMana')) return false; // i rituali richiedono di pianificare: il bot non li usa
  if (def.name === 'Aetherize') return g.active !== pid && inCombat;
  if (kinds.includes('pump') && !kinds.includes('pumpAll')) {
    return inCombat && creaturesOf(g, pid).some((c) => g.combat.attackers.has(c.id) || [...g.combat.attackers.values()].some((a) => a.blockers.includes(c.id)));
  }
  if (kinds.includes('pumpAll')) return g.active === pid && g.step === 'main1' && creaturesOf(g, pid).filter((c) => !g.isSick(c)).length >= 2;
  return myMain;
}

function abilityMoves(g, pid) {
  if (g.active !== pid || g.step !== 'main2' || g.stack.length) return [];
  const out = [];
  const tokens = mine(g, pid).filter((x) => x.isToken && isCreature(x));
  const handSize = g.zone(pid, 'hand').length;
  for (const o of mine(g, pid)) {
    const abilities = (o.def.abilities || []).filter((a) => a.kind === 'activated');
    abilities.forEach((ab, index) => {
      if (BOARD_WIPES.has(o.name)) return;
      const effects = [].concat(ab.effect);
      const kinds = effects.map((e) => e.kind);
      const action = { type: 'activate', object: o.id, ability: index, autoPay: true };
      if (ab.sacrifice === 'self') {
        const ramp = kinds.includes('search');
        if (!ramp && !(kinds.includes('draw') && handSize <= 1)) return;
        action.sacrifice = [o.id];
      } else if (ab.sacrifice) {
        const tok = tokens.find((t) => F.SACRIFICE[ab.sacrifice](g, t, pid, o));
        if (!tok) return;
        action.sacrifice = [tok.id];
      }
      if (ab.discard) {
        if (handSize <= 1) return;
        action.discard = chooseDiscard(g, pid, ab.discard);
      }
      if (o.name === 'Castle Locthwain' && (handSize > 2 || g.state.get(pid).life < 15)) return;
      const e = effectOf(effects);
      if (e?.target) {
        const t = pickTarget(g, pid, e, g.targetOptions(e.target, pid));
        if (!t) return;
        action.targets = [t];
      }
      out.push(action);
    });
  }
  return out;
}

function priorityMove(g, pid) {
  const key = `${g.turn}:${g.step}`;
  const seen = actionsThisStep.get(g) || {};
  if (seen.key !== key) actionsThisStep.set(g, { key, n: 0 });
  const counter = actionsThisStep.get(g);
  if (counter.n >= MAX_ACTIONS_PER_STEP) return { type: 'pass' };
  const attempt = (a) => (a && g.check(pid, a).ok ? a : null);
  const chosen = (() => {
    const myMain = g.active === pid && (g.step === 'main1' || g.step === 'main2') && !g.stack.length;
    if (myMain && g.state.get(pid).landsPlayed === 0) {
      const land = g.zone(pid, 'hand').find((o) => isType(o, 'Land'));
      const a = land && attempt({ type: 'playLand', object: land.id });
      if (a) return a;
    }
    const castable = [...g.zone(pid, 'hand'), ...g.zone(pid, 'command')]
      .filter((o) => !isType(o, 'Land') && timingOk(g, pid, o))
      .sort((a, b) => manaValue(b.def) - manaValue(a.def));
    for (const o of castable) {
      const a = attempt(buildCast(g, pid, o));
      if (a) return a;
    }
    for (const a of abilityMoves(g, pid)) if (attempt(a)) return a;
    return null;
  })();
  if (!chosen) return { type: 'pass' };
  counter.n++;
  return chosen;
}

// ---------- Combattimento ----------
function canBlock(g, blocker, attacker, defender) {
  if (!isCreature(blocker) || blocker.tapped || blocker.controller !== defender) return false;
  if (g.hasStatic(blocker, 'cantBlock')) return false;
  return !g.blockProblem(blocker, attacker, defender);
}

function kills(g, src, target) {
  return g.power(src) > 0 && (g.hasKw(src, 'Deathtouch') || g.power(src) >= g.toughness(target) - target.damage);
}

function declareAttackers(g, pid) {
  const attackers = [];
  for (const o of creaturesOf(g, pid)) {
    if (g.attackProblem(o) || g.power(o) <= 0) continue;
    // si attacca l'avversario con meno vita; si evita di perdere la creatura senza ottenere nulla
    const defender = lowestLifeOpponent(g, pid);
    const blockers = creaturesOf(g, defender).filter((b) => canBlock(g, b, o, defender));
    const safe = blockers.every((b) => !kills(g, b, o) || kills(g, o, b));
    if (!blockers.length || safe) attackers.push({ object: o.id, defender });
  }
  return { type: 'declareAttackers', attackers };
}

function declareBlockers(g, pid) {
  const incoming = [...g.combat.attackers].filter(([, a]) => a.defender === pid).map(([id]) => g.object(id))
    .filter(Boolean).sort((a, b) => g.power(b) - g.power(a));
  const used = new Set();
  const blocks = [];
  let damage = incoming.reduce((n, a) => n + Math.max(0, g.power(a)), 0);
  const life = g.state.get(pid).life;
  for (const att of incoming) {
    if (g.hasKw(att, 'Menace')) continue; // servirebbero due bloccanti: il bot non li coordina
    const options = creaturesOf(g, pid).filter((b) => !used.has(b.id) && canBlock(g, b, att, pid));
    // blocco vantaggioso: uccide l'attaccante e sopravvive
    const good = options.find((b) => kills(g, b, att) && !kills(g, att, b));
    // blocco di sacrificio: solo se altrimenti il danno sarebbe letale
    const chump = damage >= life ? options.sort((a, b) => value(g, a) - value(g, b))[0] : null;
    const blocker = good || chump;
    if (!blocker) continue;
    used.add(blocker.id);
    blocks.push({ blocker: blocker.id, attacker: att.id });
    if (!g.hasKw(att, 'Trample')) damage -= g.power(att);
  }
  return { type: 'declareBlockers', blocks };
}

// ---------- Decisioni ----------
function decide(g, pid, d) {
  const lands = mine(g, pid).filter((o) => isType(o, 'Land')).length;
  const byValue = (ids) => [...ids].sort((a, b) => manaValue(g.object(b).def) - manaValue(g.object(a).def));
  switch (d.type) {
    case 'declareAttackers': return declareAttackers(g, pid);
    case 'declareBlockers': return declareBlockers(g, pid);
    case 'discard': return { type: 'discard', objects: chooseDiscard(g, pid, d.count) };
    case 'chooseTarget': {
      const e = effectOf([].concat(d.trigger?.ability?.effect || [])) || { kind: d.trigger?.ability?.effect?.kind };
      const t = pickTarget(g, pid, e, d.options);
      return { type: 'chooseTarget', target: t || (d.optional ? null : d.options[0]) };
    }
    case 'confirm': {
      if (!d.mulligan) return { type: 'confirm', yes: true };
      const hand = g.zone(pid, 'hand');
      const handLands = hand.filter((o) => isType(o, 'Land')).length;
      return { type: 'confirm', yes: hand.length > 5 && (handLands < 2 || handLands > 5) };
    }
    case 'search': return { type: 'search', objects: byValue(d.options).slice(0, d.max) };
    case 'scry': {
      const keep = (id) => (isType(g.object(id), 'Land') ? lands < 6 : true);
      return { type: 'scry', top: d.cards.filter(keep), bottom: d.cards.filter((id) => !keep(id)) };
    }
    case 'putBack': return { type: 'putBack', objects: chooseDiscard(g, pid, d.count) };
    case 'chooseCards': {
      const wantLand = lands < 5;
      const score = (id) => (isType(g.object(id), 'Land') === wantLand ? 100 : 0) + manaValue(g.object(id).def);
      return { type: 'chooseCards', objects: [...d.options].sort((a, b) => score(b) - score(a)).slice(0, d.count) };
    }
    case 'chooseSacrifice': return { type: 'chooseSacrifice', object: chooseSacrifice(g, pid, d.options) };
    default: throw new Error(`Decisione non gestita dal bot: ${d.type}`);
  }
}

// La mossa del bot quando tocca a lui: una decisione in attesa oppure un'azione con la priorità
function botMove(g, pid) {
  if (g.decision) return decide(g, pid, g.decision);
  return priorityMove(g, pid);
}

module.exports = { botMove, chooseSacrifice, pickTarget };
