// Vista della partita per un giocatore: solo ciò che può vedere (CR 400.2), più gli aiuti per l'interfaccia
// (costi, bersagli legali, abilità attivabili). È una funzione pura: non modifica la partita.
const { parseCost, COLORS } = require('./mana');
const { WUBRG } = require('./identity');
const F = require('./filters');

const formatCost = (cost) => {
  const colored = COLORS.map((c) => `{${c}}`.repeat(cost[c])).join('');
  return (cost.generic || !colored ? `{${cost.generic}}` : '') + colored;
};

function objectView(g, o, ctx, { own = false, castable = false } = {}) {
  const v = {
    id: o.id,
    cardId: o.cardId,
    name: o.name,
    img: ctx.images[o.name] || null,
    art: ctx.arts?.[o.name] || null, // solo l'illustrazione, per le carte piccole sui telefoni
    artist: ctx.artists?.[o.name] || null,
    types: o.def.types,
    subtypes: o.def.subtypes || [],
    controller: o.controller,
    owner: o.owner,
    isToken: o.isToken,
    isCommander: o.isCommander,
  };
  if (o.zone === 'battlefield') {
    Object.assign(v, {
      tapped: o.tapped,
      damage: o.damage,
      counters: { ...o.counters },
      keywords: [...new Set([...(o.def.keywords || []), ...['Flying', 'Trample', 'Haste', 'Vigilance', 'Deathtouch', 'Lifelink', 'First strike',
        'Double strike', 'Menace', 'Reach', 'Hexproof', 'Indestructible', 'Defender', 'Unblockable', 'Mountainwalk'].filter((k) => g.hasKw(o, k))])],
    });
    if (o.def.types.includes('Creature')) Object.assign(v, { power: g.power(o), toughness: g.toughness(o), sick: g.isSick(o) });
    if (own) v.abilities = abilitiesOf(g, o, ctx.viewer);
  }
  if (castable) {
    v.cast = castInfo(g, o, ctx.viewer);
    v.playable = v.cast.playable;
  }
  return v;
}

// Bersagli legali per ogni posizione richiesta da una lista di effetti
function targetOptions(g, effects, pid) {
  const multi = effects.find((e) => e && e.targets)?.targets;
  if (multi) return multi.map((kind) => g.targetOptions(kind, pid));
  const kind = effects.find((e) => e && e.target)?.target;
  return kind ? [g.targetOptions(kind, pid)] : [];
}

function sacrificeOptions(g, filter, pid, src) {
  if (!filter) return null;
  return g.battlefield().filter((o) => F.SACRIFICE[filter](g, o, pid, src)).map((o) => o.id);
}

// Mossa d'esempio con i primi bersagli e costi validi: se il motore la accetta, la carta è giocabile adesso
function sampleChoices(g, targets, sacrifice, discard, pid, selfId) {
  if (targets.some((opts) => !opts.length)) return null;
  const extra = { targets: targets.map((opts) => opts[0]) };
  if (sacrifice) extra.sacrifice = sacrifice.length ? [sacrifice[0]] : [];
  if (discard) extra.discard = g.zone(pid, 'hand').filter((x) => x.id !== selfId).slice(0, discard).map((x) => x.id);
  return extra;
}

function playability(g, pid, action, extra) {
  if (!extra) return { ok: false, code: 'NO_TARGETS', message: 'Non ci sono bersagli validi in questo momento' };
  return g.check(pid, { ...action, ...extra });
}

function castInfo(g, o, pid) {
  const def = o.def;
  if (def.types.includes('Land')) return { land: true, playable: g.check(pid, { type: 'playLand', object: o.id }) };
  const modes = def.modes ? def.modes.map((m, i) => ({ index: i, name: def.modeNames?.[i] || `Modalità ${i + 1}`, targets: targetOptions(g, [m], pid) })) : null;
  const sacrifice = sacrificeOptions(g, def.additionalCost?.sacrifice, pid, o);
  const discard = def.additionalCost?.discard || 0;
  let playable;
  if (modes) {
    const m = modes.find((x) => x.targets.every((t) => t.length)) || modes[0];
    playable = playability(g, pid, { type: 'cast', object: o.id, autoPay: true, mode: m.index }, sampleChoices(g, m.targets, sacrifice, discard, pid, o.id));
  } else {
    const targets = targetOptions(g, [].concat(def.effect || []), pid);
    playable = playability(g, pid, { type: 'cast', object: o.id, autoPay: true }, sampleChoices(g, targets, sacrifice, discard, pid, o.id));
  }
  return {
    playable,
    cost: g.costToCast(pid, o.id),
    instantSpeed: def.types.includes('Instant') || (def.keywords || []).includes('Flash'),
    targets: modes ? [] : targetOptions(g, [].concat(def.effect || []), pid),
    modes,
    sacrificeOptions: sacrificeOptions(g, def.additionalCost?.sacrifice, pid, o),
    discard: def.additionalCost?.discard || 0,
  };
}

function abilitiesOf(g, o, pid) {
  const out = [];
  let activatedIndex = 0;
  for (const a of o.def.abilities || []) {
    if (a.kind !== 'mana' && a.kind !== 'activated') continue;
    const entry = {
      kind: a.kind,
      cost: a.cost.replace(/\{T\}/g, '') ? formatCost(parseCost(a.cost.replace(/\{T\}/g, ''))) : '',
      tap: a.cost.includes('{T}'),
      sacrifice: a.sacrifice || null,
      sacrificeOptions: sacrificeOptions(g, a.sacrifice, pid, o),
      discard: a.discard || 0,
    };
    const canAct = g.priority === pid && !g.decision;
    if (a.kind === 'mana') {
      entry.colors = a.produce === 'anyColor' ? WUBRG : a.produce === 'commanderIdentity' ? g.state.get(pid).identity : null;
      entry.produce = a.produce;
      if (canAct) {
        const extra = sampleChoices(g, [], entry.sacrificeOptions, 0, pid, o.id);
        entry.playable = playability(g, pid, { type: 'activateMana', object: o.id, color: entry.colors?.[0] }, extra);
      }
    } else {
      entry.index = activatedIndex++;
      entry.targets = targetOptions(g, [].concat(a.effect), pid);
      if (canAct) {
        const extra = sampleChoices(g, entry.targets, entry.sacrificeOptions, entry.discard, pid, o.id);
        entry.playable = playability(g, pid, { type: 'activate', object: o.id, ability: entry.index, autoPay: true }, extra);
      }
    }
    out.push(entry);
  }
  return out;
}

function decisionView(g, d, viewer, ctx) {
  const base = { type: d.type, player: d.player };
  if (d.player !== viewer) return base;
  const cards = (ids) => ids.map((id) => g.object(id)).filter(Boolean).map((o) => objectView(g, o, ctx));
  switch (d.type) {
    case 'chooseTarget': return { ...base, options: d.options, optional: d.optional, source: d.trigger?.source?.name };
    case 'search': return { ...base, cards: cards(d.options), max: d.max };
    case 'scry': return { ...base, cards: cards(d.cards) };
    case 'chooseCards': return { ...base, cards: cards(d.options), count: d.count };
    case 'chooseSacrifice': return { ...base, options: d.options };
    case 'discard': case 'putBack': return { ...base, count: d.count };
    case 'confirm': return { ...base, prompt: d.prompt };
    default: return base; // dichiarazione di attaccanti e bloccanti: l'interfaccia usa il campo di battaglia
  }
}

function buildView(g, viewer, { names = {}, images = {}, arts = {}, artists = {} } = {}) {
  const ctx = { viewer, images, arts, artists };
  const zone = (pid, z, opts) => g.zone(pid, z).map((o) => objectView(g, o, ctx, opts));
  const canAct = g.priority === viewer && !g.decision;
  return {
    me: viewer,
    turn: g.turn,
    step: g.step,
    active: g.active,
    priority: g.priority,
    winner: g.winner,
    players: g.seats.map((pid) => {
      const s = g.state.get(pid);
      const own = pid === viewer;
      return {
        id: pid,
        name: names[pid] || pid,
        life: s.life,
        poison: s.poison,
        lost: s.lost,
        pool: { ...s.pool },
        handCount: s.zones.hand.length,
        libraryCount: s.zones.library.length,
        commanderDamage: Object.entries(s.commanderDamage).map(([cardId, n]) => ({ cardId: Number(cardId), amount: n })),
        hand: own ? zone(pid, 'hand', { castable: canAct }) : null,
        // sul campo conta il controllore, non il proprietario (CR 108.4)
        battlefield: g.battlefield().filter((o) => o.controller === pid).map((o) => objectView(g, o, ctx, { own })),
        graveyard: zone(pid, 'graveyard'),
        exile: zone(pid, 'exile'),
        command: zone(pid, 'command', { castable: own && canAct }),
      };
    }),
    stack: g.stack.map((o) => ({
      ...objectView(g, o, ctx),
      isAbility: o.isAbility,
      targets: o.targets,
    })),
    decision: g.decision ? decisionView(g, g.decision, viewer, ctx) : null,
    combat: g.combat ? {
      attackers: [...g.combat.attackers].map(([id, a]) => ({ id, defender: a.defender, blockers: [...a.blockers] })),
    } : null,
  };
}

module.exports = { buildView };
