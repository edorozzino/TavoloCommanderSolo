// Stato della partita, turno (CR 500-514), priorità (CR 117), Pila (CR 405, 601, 602, 608),
// caratteristiche calcolate (CR 613, semplificato), azioni basate sullo stato (CR 704) e regole Commander (CR 903).
const { createRng } = require('./rng');
const { getCard, getToken } = require('./cards');
const { emptyPool, parseCost, canPay, pay, COLORS } = require('./mana');
const { RuleError } = require('./errors');
const { colorIdentity, colorsOf, WUBRG } = require('./identity');
const F = require('./filters');

const { isType, isCreature, isGoblin, hasSub } = F;

const STEPS = [
  'untap', 'upkeep', 'draw', 'main1',
  'beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat',
  'main2', 'end', 'cleanup',
];
const NO_PRIORITY_STEPS = new Set(['untap', 'cleanup']); // CR 502.4, 514.3
const MAIN_STEPS = new Set(['main1', 'main2']);
const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
const PERMANENT_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'];
const MAX_HAND_SIZE = 7; // CR 402.2
const COMMANDER_DAMAGE_LIMIT = 21; // CR 903.10a

const isPermanentCard = (o) => o.def.types.some((t) => PERMANENT_TYPES.includes(t));
const sameTarget = (a, b) => (a.player ? a.player === b.player : a.object === b.object);
const targetKindOf = (effects) => effects.find((e) => e && e.target)?.target || null;
// Bersagli multipli di tipo diverso (es. Bite Down): un tipo per posizione
const targetKindsOf = (effects) => effects.find((e) => e && e.targets)?.targets || null;

function formatCost(cost) {
  const colored = COLORS.map((c) => `{${c}}`.repeat(cost[c])).join('');
  return (cost.generic || !colored ? `{${cost.generic}}` : '') + colored;
}

class Game {
  constructor({ seed = 1, mulligan = false, orderTriggers = false, assignDamage = false, players }) {
    if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
      throw new Error('Una partita Commander richiede da 2 a 4 giocatori');
    }
    this.rng = createRng(seed);
    this.nextId = 1;
    this.objects = new Map();
    this.events = [];
    this.seats = players.map((p) => p.id); // ordine di turno, compresi i giocatori eliminati
    this.state = new Map();
    this.stackIds = [];
    this.winner = null;
    this.decision = null; // scelta che un giocatore deve fare prima che il gioco prosegua
    this.pendingTriggers = []; // abilità innescate in attesa di andare sulla Pila (CR 603.3)
    this.triggerQueue = [];
    this.askDamage = assignDamage; // se attivo, chi attacca divide il danno tra più bloccanti (CR 510.1c)
    this.askTriggerOrder = orderTriggers; // se attivo, ogni giocatore ordina i propri inneschi simultanei (CR 603.3b)
    this.eot = []; // effetti che durano fino alla fine del turno (CR 514.2)
    this.enteredThisTurn = {}; // Goblin entrati sotto il controllo di ciascun giocatore in questo turno
    this.onceThisTurn = new Set(); // abilità "solo una volta per turno" già innescate
    this.combat = null;
    this.turn = 0;
    for (const p of players) {
      this.state.set(p.id, {
        id: p.id,
        life: 40,
        poison: 0,
        pool: emptyPool(),
        lost: false,
        drewFromEmpty: false,
        landsPlayed: 0,
        lastTurnStart: 0, // numero dell'ultimo turno iniziato da questo giocatore (CR 302.6)
        commanderCasts: {}, // carta fisica del comandante -> lanci dalla zona di comando
        commanderDamage: {}, // carta fisica del comandante -> danni da combattimento subiti
        identity: [...new Set((p.commanders || []).flatMap((n) => colorIdentity(getCard(n))))],
        preferences: { commanderToCommandZone: true },
        zones: Object.fromEntries(ZONES.map((z) => [z, []])),
      });
      for (const name of p.commanders || []) this.create(p.id, name, 'command', { isCommander: true });
      for (const name of p.library || []) this.create(p.id, name, 'library');
      this.rng.shuffle(this.state.get(p.id).zones.library);
    }
    for (const id of this.seats) this.draw(id, 7); // CR 103.5
    this.turn = 1;
    this.active = this.seats[0];

    // Strumenti per preparare scenari (test e lezioni dell'Accademia)
    this.setup = {
      putOnBattlefield: (pid, name, opts = {}) => this.create(pid, name, 'battlefield', { ...opts, controlSince: opts.sick ? this.turn : -1 }),
      putInHand: (pid, name) => this.create(pid, name, 'hand'),
      putInGraveyard: (pid, name) => this.create(pid, name, 'graveyard'),
      putInLibrary: (pid, name) => {
        const id = this.create(pid, name, 'library');
        const lib = this.state.get(pid).zones.library;
        lib.unshift(lib.pop());
        return id;
      },
      moveTo: (id, zone, opts = {}) => this.move(id, zone, { manual: true, controlSince: opts.sick === false ? -1 : undefined }),
      createToken: (pid, name) => this.createToken(pid, name, { controlSince: -1 }),
      gainControl: (id, pid) => Object.assign(this.objects.get(id), { controller: pid, controlSince: this.turn }),
      setControlSince: (id, turn) => { this.objects.get(id).controlSince = turn; },
      addCommanderDamage: (pid, cardId, n) => {
        const d = this.state.get(pid).commanderDamage;
        d[cardId] = (d[cardId] || 0) + n;
      },
      setLife: (pid, life) => { this.state.get(pid).life = life; },
      setPoison: (pid, poison) => { this.state.get(pid).poison = poison; },
      setPreference: (pid, key, value) => { this.state.get(pid).preferences[key] = value; },
    };

    if (mulligan) this.startMulligans();
    else this.enterStep('untap');
  }

  // ---------- Mulligan (CR 103.5) ----------
  startMulligans() {
    this.step = 'mulligan';
    this.mulligansTaken = new Map(this.seats.map((p) => [p, 0]));
    this.mulliganRound(this.seats);
  }

  // Quante carte finiscono in fondo dopo N mulligan: in multiplayer il primo è gratis (CR 103.5c)
  mulliganBottomCount(taken) {
    return this.seats.length > 2 ? Math.max(0, taken - 1) : taken;
  }

  // Un giro di dichiarazioni in ordine di turno; i mulligan si fanno poi tutti insieme.
  // Chi tiene la mano esce dal giro; con una mano già a zero carte non si può più fare mulligan.
  mulliganRound(players) {
    const asked = players.filter((p) => this.mulliganBottomCount(this.mulligansTaken.get(p)) < 7);
    if (!asked.length) {
      this.enterStep('untap');
      return;
    }
    const takers = [];
    const declare = (i) => {
      if (i === asked.length) {
        if (takers.length) this.takeMulligans(takers);
        else this.enterStep('untap');
        return;
      }
      const pid = asked[i];
      const bottom = this.mulliganBottomCount(this.mulligansTaken.get(pid) + 1);
      this.ask({
        type: 'confirm', player: pid, mulligan: true,
        prompt: `Vuoi fare mulligan? Rimescoli la mano e peschi 7 carte${bottom ? `, poi ne metti ${bottom} in fondo al grimorio` : ' (il primo è gratis)'}.`,
        resume: (yes) => {
          if (yes) takers.push(pid);
          declare(i + 1);
        },
      });
    };
    declare(0);
  }

  takeMulligans(takers) {
    const mark = this.events.length; // le carte che si rimescolano sono nascoste: non devono finire nel registro
    for (const pid of takers) {
      const s = this.state.get(pid);
      for (const id of [...s.zones.hand]) this.move(id, 'library', { manual: true });
      this.rng.shuffle(s.zones.library);
      this.draw(pid, 7);
      this.mulligansTaken.set(pid, this.mulligansTaken.get(pid) + 1);
    }
    this.events.length = mark;
    for (const pid of takers) this.events.push({ type: 'mulligan', player: pid });
    const bottom = (i) => {
      if (i === takers.length) {
        this.mulliganRound(takers);
        return;
      }
      const count = this.mulliganBottomCount(this.mulligansTaken.get(takers[i]));
      if (!count) {
        bottom(i + 1);
        return;
      }
      this.ask({ type: 'putBack', player: takers[i], count, bottom: true, resume: () => bottom(i + 1) });
    };
    bottom(0);
  }

  // ---------- Lettura dello stato ----------
  get players() {
    return this.seats.filter((pid) => !this.state.get(pid).lost);
  }

  get stack() {
    return this.stackIds.map((id) => this.objects.get(id));
  }

  player(pid) {
    const s = this.state.get(pid);
    return {
      id: s.id,
      life: s.life,
      poison: s.poison,
      pool: { ...s.pool },
      handSize: s.zones.hand.length,
      commanderCasts: Object.values(s.commanderCasts).reduce((a, b) => a + b, 0),
      commanderDamage: { ...s.commanderDamage },
    };
  }

  hasLost(pid) {
    return this.state.get(pid).lost;
  }

  isAlive(pid) {
    return this.state.has(pid) && !this.state.get(pid).lost;
  }

  zone(pid, zone) {
    return this.state.get(pid).zones[zone].map((id) => this.objects.get(id));
  }

  object(id) {
    return this.objects.get(id);
  }

  battlefield() {
    return [...this.objects.values()].filter((o) => o.zone === 'battlefield');
  }

  // ---------- Caratteristiche calcolate (CR 613, semplificato: valore base, segnalini, effetti statici, fino a fine turno) ----------
  staticAbilities() {
    const out = [];
    for (const src of this.battlefield()) {
      for (const a of src.def.abilities || []) if (a.kind === 'static' && this.conditionHolds(a.condition, src.controller)) out.push({ src, a });
    }
    return out;
  }

  conditionHolds(condition, pid) {
    if (!condition) return true;
    if (condition === 'controlsCommander') return this.battlefield().some((o) => o.isCommander && o.owner === pid && o.controller === pid);
    throw new Error(`Condizione non supportata: ${condition}`);
  }

  // what = 'pt' (forza e costituzione) oppure 'kw' (keyword): calcolati separatamente, così un effetto che concede
  // keyword in base alla forza (Tetsuko Umezawa) può leggere la forza senza ricorsione
  modifiers(o, what = 'all') {
    const mods = { power: 0, toughness: 0, keywords: new Set(), cantBeBlocked: false };
    if (o.zone !== 'battlefield') return mods;
    for (const { src, a } of this.staticAbilities()) {
      const an = a.anthem;
      const relevant = an && (what === 'all' || (what === 'pt' ? an.power || an.toughness : an.keywords));
      if (relevant && F.GROUP[an.filter](this, o, src)) {
        mods.power += an.power || 0;
        mods.toughness += an.toughness || 0;
        for (const k of an.keywords || []) mods.keywords.add(k);
      }
      if (a.selfBoost && src.id === o.id && what !== 'kw') {
        const n = a.selfBoost.flat ? 1 : this.battlefield().filter((x) => F.GROUP[a.selfBoost.per](this, x, o)).length;
        mods.power += n * (a.selfBoost.power || 0);
        mods.toughness += n * (a.selfBoost.toughness || 0);
      }
    }
    for (const e of this.eot) {
      if (e.id !== o.id) continue;
      mods.power += e.power || 0;
      mods.toughness += e.toughness || 0;
      for (const k of e.keywords || []) mods.keywords.add(k);
      if (e.cantBeBlocked) mods.cantBeBlocked = true;
    }
    return mods;
  }

  basePT(o) {
    if (o.def.cda) {
      const n = this.count(o.def.cda, { controller: o.controller, source: o.id });
      return [n, n];
    }
    return [o.def.power ?? 0, o.def.toughness ?? 0];
  }

  power(o) {
    return this.basePT(o)[0] + (o.counters['+1/+1'] || 0) + this.modifiers(o, 'pt').power;
  }

  toughness(o) {
    return this.basePT(o)[1] + (o.counters['+1/+1'] || 0) + this.modifiers(o, 'pt').toughness;
  }

  hasKw(o, keyword) {
    return (o.def.keywords || []).includes(keyword) || this.modifiers(o, 'kw').keywords.has(keyword);
  }

  cantBeBlocked(o) {
    return this.hasKw(o, 'Unblockable') || this.modifiers(o, 'kw').cantBeBlocked;
  }

  hasStatic(o, key) {
    return (o.def.abilities || []).some((a) => a.kind === 'static' && a[key]);
  }

  maxHandSize(pid) {
    return this.battlefield().some((o) => o.controller === pid && this.hasStatic(o, 'noMaxHandSize')) ? Infinity : MAX_HAND_SIZE;
  }

  // Quantità variabili usate dagli effetti ("pari al numero di Goblin che controlli", ecc.)
  count(spec, ctx) {
    if (typeof spec === 'number') return spec;
    const name = typeof spec === 'string' ? spec : spec.count;
    const field = this.battlefield();
    const mine = (o) => o.controller === ctx.controller;
    switch (name) {
      case 'goblinsYouControl': return field.filter((o) => mine(o) && isGoblin(o)).length;
      case 'goblinsOnBattlefield': return field.filter(isGoblin).length;
      case 'creaturesYouControl': return field.filter((o) => mine(o) && isCreature(o)).length;
      case 'creatureOnBattlefield': return field.filter(isCreature).length;
      case 'goblinsEnteredThisTurn': return this.enteredThisTurn[ctx.controller] || 0;
      case 'opponents': return this.players.filter((p) => p !== ctx.controller).length;
      case 'elvesOnBattlefield': return field.filter((o) => hasSub(o, 'Elf')).length;
      case 'elvesYouControl': return field.filter((o) => mine(o) && hasSub(o, 'Elf')).length;
      case 'totalPowerYouControl': return field.filter((o) => mine(o) && isCreature(o)).reduce((n, o) => n + Math.max(0, this.power(o)), 0);
      case 'greatestPowerYouControl': return Math.max(0, ...field.filter((o) => mine(o) && isCreature(o)).map((o) => this.power(o)));
      case 'greatestPowerNonHumanYouControl': return Math.max(0, ...field.filter((o) => mine(o) && isCreature(o) && !hasSub(o, 'Human')).map((o) => this.power(o)));
      case 'creaturesPower4YouControl': return field.filter((o) => mine(o) && isCreature(o) && this.power(o) >= 4).length * (spec.times || 1);
      case 'subjectToughness': { const o = this.objects.get(ctx.subject); return o && o.zone === 'battlefield' ? this.toughness(o) : 0; }
      case 'damageDealt': return ctx.amount || 0;
      case 'swampsYouControl': return field.filter((o) => mine(o) && hasSub(o, 'Swamp')).length;
      case 'handSize': return this.state.get(ctx.controller).zones.hand.length;
      case 'devotionBlack': // CR 700.5: simboli {B} nei costi dei permanenti che controlli
        return field.filter(mine).reduce((n, o) => n + (String(o.def.cost || '').match(/\{B\}/g) || []).length, 0);
      case 'sacrificedPower': return ctx.sacrificedPower || 0;
      case 'selfPower': {
        const src = this.objects.get(ctx.source);
        return src && src.zone === 'battlefield' ? this.power(src) : ctx.lkiPower || 0;
      }
      default: throw new Error(`Conteggio non supportato: ${name}`);
    }
  }

  // Costo totale per lanciare una carta: tassa del comandante (CR 903.8) e riduzioni (CR 601.2f)
  costToCast(pid, id) {
    return formatCost(this.totalCost(pid, this.objects.get(id)));
  }

  totalCost(pid, o) {
    const cost = parseCost(o.def.cost || '');
    if (o.zone === 'command') cost.generic += 2 * (this.state.get(pid).commanderCasts[o.cardId] || 0);
    for (const { src, a } of this.staticAbilities()) {
      if (a.costReduction && src.controller === pid && F.SPELL[a.costReduction.filter](o.def)) cost.generic -= a.costReduction.amount;
    }
    if (o.def.costReductionPer) cost.generic -= this.count(o.def.costReductionPer, { controller: pid });
    cost.generic = Math.max(0, cost.generic);
    return cost;
  }

  // ---------- Oggetti e zone ----------
  create(owner, name, zone, opts = {}) {
    const id = this.nextId++;
    const def = opts.def || getCard(name);
    const o = {
      id,
      cardId: opts.cardId ?? id, // la carta fisica: resta la stessa quando l'oggetto cambia zona
      name,
      def,
      isToken: !!opts.isToken,
      isAbility: !!opts.isAbility,
      owner,
      controller: opts.controller || owner,
      zone,
      tapped: opts.tapped ?? (zone === 'battlefield' && (!!def.entersTapped
        || (def.entersTappedUnless === 'controlsSwamp' && !this.battlefield().some((x) => x.controller === (opts.controller || owner) && hasSub(x, 'Swamp'))))),
      damage: 0,
      deathtouched: false,
      counters: {},
      // turno da cui il controllore attuale controlla il permanente: serve per la debolezza da evocazione
      controlSince: opts.controlSince ?? (zone === 'battlefield' ? this.turn : null),
      isCommander: !!opts.isCommander,
      targets: opts.targets || [],
    };
    if (zone === 'battlefield' && def.entersWithCounters) o.counters['+1/+1'] = def.entersWithCounters; // CR 614.1c
    this.objects.set(id, o);
    if (zone === 'stack') this.stackIds.push(id);
    else this.state.get(owner).zones[zone].push(id);
    if (zone === 'battlefield') this.onEnter(o);
    return id;
  }

  createToken(controller, name, opts = {}) {
    const def = getToken(name);
    return this.create(controller, def.name, 'battlefield', { ...opts, def, isToken: true });
  }

  // Inneschi di entrata: quelli del permanente stesso e quelli di chi osserva le creature che entrano
  onEnter(o) {
    if (isCreature(o) && isGoblin(o)) this.enteredThisTurn[o.controller] = (this.enteredThisTurn[o.controller] || 0) + 1;
    for (const a of this.triggersOf(o, 'etb')) this.queueTrigger(o, a);
    for (const w of this.battlefield()) {
      for (const a of this.triggersOf(w, 'creatureEnters')) if (F.TRIGGER[a.filter](this, o, w)) this.queueTrigger(w, a, { subject: o.id });
      for (const a of this.triggersOf(w, 'landEnters')) if (F.TRIGGER[a.filter](this, o, w)) this.queueTrigger(w, a, { subject: o.id }); // approdo
    }
  }

  remove(id) {
    const o = this.objects.get(id);
    const list = o.zone === 'stack' ? this.stackIds : this.state.get(o.owner).zones[o.zone];
    list.splice(list.indexOf(id), 1);
    this.objects.delete(id);
    this.eot = this.eot.filter((e) => e.id !== id);
    return o;
  }

  // Cambiando zona una carta diventa un oggetto nuovo (CR 400.7); fuori dal campo e dalla Pila
  // va sempre nelle zone del proprietario (CR 400.3)
  move(id, zone, opts = {}) {
    const leaving = this.objects.get(id);
    if (leaving.isCommander && (zone === 'hand' || zone === 'library') && !opts.manual
      && this.state.get(leaving.owner).preferences.commanderToCommandZone) zone = 'command'; // CR 903.9b
    if (leaving.zone === 'battlefield' && zone !== 'battlefield') {
      for (const a of this.triggersOf(leaving, 'leaves')) this.queueTrigger(leaving, a); // CR 603.6c
    }
    // Carte creatura (non token) che arrivano nel cimitero da fuori dal campo, o che lasciano un cimitero (Syr Konrad, Dreadhound)
    if (isCreature(leaving) && !leaving.isToken && !leaving.isAbility) {
      const toGrave = zone === 'graveyard' && leaving.zone !== 'battlefield' && leaving.zone !== 'graveyard';
      const fromGrave = leaving.zone === 'graveyard' && zone !== 'graveyard';
      for (const w of this.battlefield()) {
        if (toGrave) {
          for (const a of this.triggersOf(w, 'creatureCardToGraveyard')) if (!a.from || a.from === leaving.zone) this.queueTrigger(w, a);
        }
        if (fromGrave && leaving.owner === w.controller) {
          for (const a of this.triggersOf(w, 'creatureCardLeavesYourGraveyard')) this.queueTrigger(w, a);
        }
      }
    }
    const o = this.remove(id);
    const newId = this.create(o.owner, o.name, zone, {
      cardId: o.cardId, isCommander: o.isCommander, targets: opts.targets, controlSince: opts.controlSince,
      controller: opts.controller, def: o.isToken ? o.def : undefined, isToken: o.isToken, tapped: opts.tapped,
    });
    if (opts.top && zone === 'library') {
      const lib = this.state.get(o.owner).zones.library;
      lib.unshift(lib.pop());
    }
    this.events.push({ type: 'move', card: o.cardId, name: o.name, owner: o.owner, from: o.zone, to: zone, token: o.isToken, ability: o.isAbility });
    return newId;
  }

  draw(pid, n = 1) {
    const s = this.state.get(pid);
    for (let i = 0; i < n; i++) {
      if (!s.zones.library.length) {
        s.drewFromEmpty = true; // perderà alla prossima verifica (CR 704.5b)
        return;
      }
      this.move(s.zones.library[0], 'hand');
      for (const w of this.battlefield()) { // CR 603.2 (Consecrated Sphinx)
        if (w.controller !== pid) for (const a of this.triggersOf(w, 'opponentDraws')) this.queueTrigger(w, a);
      }
    }
  }

  manaValue(o) { // CR 202.3
    const c = parseCost(o.def.cost || '');
    return c.generic + COLORS.reduce((n, k) => n + c[k], 0);
  }

  // Ordine APNAP a partire dal giocatore attivo
  apnap(players) {
    const n = this.seats.length;
    const distance = (pid) => (this.seats.indexOf(pid) - this.seats.indexOf(this.active) + n) % n;
    return [...players].sort((x, y) => distance(x) - distance(y));
  }

  chooseSacrifice(pid, options, done) {
    if (options.length === 1) return done(options[0]); // nessuna scelta reale da fare
    this.ask({ type: 'chooseSacrifice', player: pid, options, resume: done });
  }

  // "Ogni giocatore/avversario sacrifica una creatura a sua scelta": si sceglie in ordine APNAP, poi si sacrifica tutto insieme (CR 101.4)
  sacrificeRound(effect, ctx, resume) {
    const who = this.apnap(this.players.filter((p) => effect.who === 'eachPlayer' || p !== ctx.controller));
    const chosen = [];
    const cant = [];
    const next = (i) => {
      if (i >= who.length) {
        this.toGraveyard(chosen.map((id) => this.objects.get(id)));
        const discards = cant.filter((p) => this.state.get(p).zones.hand.length);
        const discardNext = (j) => {
          if (j >= discards.length) return resume();
          this.ask({ type: 'discard', player: discards[j], count: 1, resume: () => discardNext(j + 1) });
        };
        return effect.discardIfCant ? discardNext(0) : resume();
      }
      const p = who[i];
      const options = this.battlefield().filter((o) => o.controller === p && (isCreature(o) || (effect.discardIfCant && isType(o, 'Planeswalker')))).map((o) => o.id);
      if (!options.length) { cant.push(p); return next(i + 1); }
      this.chooseSacrifice(p, options, (id) => { chosen.push(id); next(i + 1); });
    };
    next(0);
  }

  // Exhume: ogni giocatore sceglie una carta creatura del proprio cimitero, poi entrano tutte insieme
  exhumeRound(ctx, resume) {
    const who = this.apnap(this.players);
    const chosen = [];
    const next = (i) => {
      if (i >= who.length) {
        for (const id of chosen) this.move(id, 'battlefield');
        return resume();
      }
      const options = this.zone(who[i], 'graveyard').filter(isCreature).map((o) => o.id);
      if (!options.length) return next(i + 1);
      if (options.length === 1) { chosen.push(options[0]); return next(i + 1); }
      this.ask({ type: 'chooseCards', player: who[i], options, count: 1, keep: true, resume: (ids) => { chosen.push(...ids); next(i + 1); } });
    };
    next(0);
  }

  // Macinare: le prime carte del grimorio vanno nel cimitero (CR 701.17)
  mill(pid, n) {
    for (const id of this.state.get(pid).zones.library.slice(0, n)) this.move(id, 'graveyard');
  }

  // Permanenti messi nel cimitero dal campo: gli inneschi "quando muore" guardano il campo com'era prima (CR 603.10a)
  toGraveyard(list) {
    const before = this.battlefield();
    for (const d of list) {
      if (d.zone !== 'battlefield' || !isCreature(d)) continue;
      for (const w of before) {
        for (const a of this.triggersOf(w, 'dies')) {
          const matches = a.filter ? F.TRIGGER[a.filter](this, d, w) : d.id === w.id;
          if (matches) this.queueTrigger(w, a, { lkiPower: this.power(w), subject: d.id, subjectController: d.controller });
        }
      }
    }
    for (const d of list) if (this.objects.get(d.id) === d) this.move(d.id, 'graveyard');
  }

  // ---------- Turno e priorità ----------
  enterStep(step) {
    this.step = step;
    this.passes = 0;
    if (step === 'untap') {
      const s = this.state.get(this.active);
      s.landsPlayed = 0;
      s.lastTurnStart = this.turn;
      this.enteredThisTurn = {};
      this.onceThisTurn = new Set();
      for (const o of this.battlefield()) {
        if (o.controller === this.active && !this.hasStatic(o, 'doesntUntap')) o.tapped = false; // CR 502.3
      }
    }
    if (step === 'upkeep') { // CR 503.1
      for (const o of this.battlefield()) {
        if (o.controller === this.active) this.triggersOf(o, 'upkeep').filter((a) => !a.from).forEach((a) => this.queueTrigger(o, a));
      }
      for (const o of this.zone(this.active, 'graveyard')) {
        this.triggersOf(o, 'upkeep').filter((a) => a.from === 'graveyard').forEach((a) => this.queueTrigger(o, a));
      }
    }
    if (step === 'draw' && !(this.seats.length === 2 && this.turn === 1)) this.draw(this.active); // CR 103.8
    if (step === 'declareAttackers') {
      this.combat = { attackers: new Map(), dealtFirst: new Set() };
      if (this.battlefield().some((o) => o.controller === this.active && isCreature(o))) {
        this.ask({ type: 'declareAttackers', player: this.active }); // CR 508.1
        return;
      }
    }
    if (step === 'declareBlockers') {
      this.pendingDefenders = this.defendersInOrder();
      this.askNextDefender();
      return;
    }
    if (step === 'firstStrikeDamage') {
      if (!this.combatants().some((o) => this.isFirstStriker(o))) return this.endStep(); // CR 510.4
      if (this.askDamageAssignments(true)) return;
      this.dealCombatDamage(true);
    }
    if (step === 'combatDamage') {
      if (this.askDamageAssignments(false)) return;
      this.dealCombatDamage(false);
    }
    if (step === 'cleanup') {
      const excess = this.state.get(this.active).zones.hand.length - this.maxHandSize(this.active);
      if (excess > 0) {
        this.ask({ type: 'discard', player: this.active, count: excess }); // CR 514.1
        return;
      }
    }
    if (NO_PRIORITY_STEPS.has(step)) {
      this.priority = null;
      this.endStep();
    } else {
      this.givePriority(this.active);
    }
  }

  endStep() {
    for (const s of this.state.values()) s.pool = emptyPool(); // CR 500.4
    if (this.winner) return;
    if (this.step === 'cleanup') {
      for (const o of this.objects.values()) o.damage = 0; // CR 514.2
      for (const o of this.objects.values()) o.deathtouched = false;
      this.eot = [];
      this.turn++;
      this.active = this.nextPlayer(this.active);
      this.enterStep('untap');
      return;
    }
    let next = STEPS[STEPS.indexOf(this.step) + 1];
    if (this.step === 'declareAttackers' && this.combat.attackers.size === 0) next = 'endCombat'; // CR 508.8
    if (this.step === 'endCombat') this.combat = null; // CR 511.3
    this.enterStep(next);
  }

  // Il gioco si ferma finché il giocatore indicato non prende una decisione
  ask(decision) {
    this.priority = null;
    this.decision = decision;
  }

  // Prossimo giocatore ancora in partita nell'ordine dei posti
  nextPlayer(pid) {
    const i = this.seats.indexOf(pid);
    for (let k = 1; k <= this.seats.length; k++) {
      const next = this.seats[(i + k) % this.seats.length];
      if (!this.state.get(next).lost) return next;
    }
    return null;
  }

  // Prima che un giocatore riceva la priorità: azioni di stato e inneschi, finché non ce ne sono più (CR 117.5)
  givePriority(pid) {
    this.resumePid = pid;
    for (;;) {
      this.checkStateBasedActions();
      if (this.winner) {
        this.priority = null;
        return;
      }
      if (this.askLegendRule()) return;
      const placed = this.flushTriggers();
      if (placed === 'waiting') return;
      if (!placed) break;
    }
    this.priority = this.state.get(pid).lost ? this.nextPlayer(pid) : pid;
  }

  // ---------- Azioni basate sullo stato (CR 704) ----------
  checkStateBasedActions() {
    for (let changed = true; changed; ) {
      changed = false;
      for (const pid of this.players) {
        const s = this.state.get(pid);
        const commanderKill = Object.values(s.commanderDamage).some((n) => n >= COMMANDER_DAMAGE_LIMIT); // CR 704.6c
        if (s.life <= 0 || s.poison >= 10 || s.drewFromEmpty || commanderKill) { // CR 704.5a, 704.5c, 704.5b
          this.eliminate(pid);
          changed = true;
        }
      }
      const dying = this.battlefield().filter((o) => {
        if (!isCreature(o)) return false;
        const t = this.toughness(o);
        if (t <= 0) return true; // CR 704.5f
        return !this.hasKw(o, 'Indestructible') && (o.damage >= t || (o.deathtouched && o.damage > 0)); // CR 704.5g-h
      });
      if (dying.length) {
        this.toGraveyard(dying);
        changed = true;
      }
      for (const o of this.battlefield()) { // CR 704.5q
        const n = Math.min(o.counters['+1/+1'] || 0, o.counters['-1/-1'] || 0);
        if (!n) continue;
        for (const kind of ['+1/+1', '-1/-1']) {
          o.counters[kind] -= n;
          if (!o.counters[kind]) delete o.counters[kind];
        }
        changed = true;
      }
      for (const o of [...this.objects.values()]) {
        if (o.isToken && o.zone !== 'battlefield') { // CR 704.5d
          this.remove(o.id);
          changed = true;
        }
      }
      for (const o of [...this.objects.values()]) {
        if (o.isCommander && (o.zone === 'graveyard' || o.zone === 'exile')
          && this.state.get(o.owner).preferences.commanderToCommandZone) { // CR 903.9a
          this.move(o.id, 'command');
          changed = true;
        }
      }
    }
  }

  // Regola delle leggende (CR 704.5j): il controllore sceglie quale tenere, le altre vanno nel cimitero.
  // Richiede una scelta, quindi sospende la priorità finché il giocatore non risponde.
  askLegendRule() {
    const groups = new Map();
    for (const o of this.battlefield()) {
      if (!(o.def.supertypes || []).includes('Legendary')) continue;
      const key = `${o.controller}\n${o.name}`;
      groups.set(key, [...(groups.get(key) || []), o]);
    }
    const group = [...groups.values()].find((list) => list.length > 1);
    if (!group) return false;
    const pid = this.resumePid;
    this.ask({
      type: 'chooseCards', player: group[0].controller, options: group.map((o) => o.id), count: 1, keep: true,
      prompt: `Regola delle leggende: scegli quale ${group[0].name} tenere`,
      resume: ([kept]) => {
        this.toGraveyard(group.filter((o) => o.id !== kept));
        this.givePriority(pid);
      },
    });
    return true;
  }

  // Un giocatore lascia la partita con tutti gli oggetti che possiede; finiscono anche gli effetti che gli davano
  // il controllo di oggetti altrui, e ciò che controlla ancora viene esiliato (CR 800.4a)
  eliminate(pid) {
    this.state.get(pid).lost = true;
    for (const o of [...this.objects.values()]) if (o.owner === pid) this.remove(o.id);
    for (const o of [...this.objects.values()]) {
      if (o.controller !== pid) continue;
      if (o.zone === 'battlefield') Object.assign(o, { controller: o.owner, controlSince: this.turn });
      else if (o.zone === 'stack') this.move(o.id, 'exile');
    }
    this.pendingTriggers = this.pendingTriggers.filter((t) => t.controller !== pid);
    this.triggerQueue = this.triggerQueue.filter((t) => t.controller !== pid);
    this.events.push({ type: 'lose', player: pid });
    if (this.players.length === 1) this.winner = this.players[0]; // CR 104.2a
  }

  // ---------- Abilità innescate (CR 603) ----------
  triggersOf(o, when) {
    return (o.def.abilities || []).filter((a) => a.kind === 'triggered' && a.when === when);
  }

  queueTrigger(source, ability, extra = {}) {
    if (ability.oncePerTurn) {
      const key = `${source.cardId}:${(source.def.abilities || []).indexOf(ability)}`;
      if (this.onceThisTurn.has(key)) return;
      this.onceThisTurn.add(key);
    }
    this.pendingTriggers.push({ controller: source.controller, source, ability, ...extra });
  }

  // Mette sulla Pila gli inneschi in attesa: prima quelli del giocatore attivo, poi gli altri in ordine di turno (APNAP).
  // Un innesco con bersaglio chiede la scelta al suo controllore; senza bersagli legali viene rimosso (CR 603.3d).
  flushTriggers() {
    if (this.pendingTriggers.length) {
      const n = this.seats.length;
      const distance = (pid) => (this.seats.indexOf(pid) - this.seats.indexOf(this.active) + n) % n;
      const fresh = this.pendingTriggers.sort((x, y) => distance(x.controller) - distance(y.controller));
      this.pendingTriggers = [];
      this.triggerQueue.push(...fresh);
    }
    if (this.askOrderOfTriggers()) return 'waiting';
    let placed = false;
    while (this.triggerQueue.length) {
      const t = this.triggerQueue.shift();
      if (!this.isAlive(t.controller)) continue;
      if (t.ability.target) {
        const options = this.targetOptions(t.ability.target, t.controller);
        if (!options.length) continue;
        this.ask({ type: 'chooseTarget', player: t.controller, options, optional: !!t.ability.optional, trigger: t });
        return 'waiting';
      }
      this.putTriggerOnStack(t, []);
      placed = true;
    }
    return placed;
  }

  // CR 603.3b: chi controlla più inneschi simultanei sceglie l'ordine, in APNAP. Se sono indistinguibili non si chiede.
  askOrderOfTriggers() {
    if (!this.askTriggerOrder) return false;
    const key = (t) => `${t.source.name}:${(t.source.def.abilities || []).indexOf(t.ability)}`;
    for (const t of this.triggerQueue) {
      if (t.ordered) continue;
      const group = this.triggerQueue.filter((x) => x.controller === t.controller && !x.ordered);
      group.forEach((x) => { x.ordered = true; });
      if (group.length < 2 || new Set(group.map(key)).size < 2) continue;
      this.ask({
        type: 'orderTriggers', player: t.controller, group,
        resume: (placed) => {
          const slots = group.map((x) => this.triggerQueue.indexOf(x));
          placed.forEach((x, i) => { this.triggerQueue[slots[i]] = x; });
        },
      });
      return true;
    }
    return false;
  }

  putTriggerOnStack(t, targets) {
    this.putAbilityOnStack(t.controller, t.source, [].concat(t.ability.effect), targets, {
      defender: t.defender, lkiPower: t.lkiPower, subject: t.subject, amount: t.amount, subjectController: t.subjectController,
    });
  }

  putAbilityOnStack(controller, source, effects, targets, extra = {}) {
    const id = this.create(controller, source.name, 'stack', { def: { name: source.name, types: [] }, isAbility: true, targets });
    Object.assign(this.objects.get(id), {
      effects, targetKind: targetKindOf(effects), targetKinds: targetKindsOf(effects), sourceId: source.id, sourceCard: source.cardId, ...extra,
    });
    return id;
  }

  targetOptions(kind, pid) {
    const out = this.players.map((p) => ({ player: p })).filter((t) => this.targetIsLegal(kind, t, pid));
    for (const o of this.objects.values()) if (this.targetIsLegal(kind, { object: o.id }, pid)) out.push({ object: o.id });
    return out;
  }

  targetIsLegal(kind, t, pid) {
    const test = F.TARGET[kind];
    if (!test) throw new Error(`Tipo di bersaglio non supportato: ${kind}`);
    return !!t && test(this, t, pid);
  }

  // ---------- Pila ----------
  resolveTop(onComplete) {
    const spell = this.objects.get(this.stackIds[this.stackIds.length - 1]);
    // le abilità non vanno in nessuna zona quando lasciano la Pila (CR 113.7)
    const done = () => {
      if (this.objects.get(spell.id)) {
        if (spell.isAbility) this.remove(spell.id);
        else this.move(spell.id, 'graveyard'); // CR 608.2n
      }
      onComplete();
    };
    const kindAt = (i) => (spell.targetKinds ? spell.targetKinds[i] : spell.targetKind);
    const byIndex = spell.targets.map((t, i) => (this.targetIsLegal(kindAt(i), t, spell.controller) ? t : null));
    const legal = byIndex.filter(Boolean);
    if (spell.targets.length && !legal.length) {
      this.events.push({ type: 'fizzle', card: spell.cardId, ability: spell.isAbility }); // CR 608.2b
      done();
      return;
    }
    if (!spell.isAbility && isPermanentCard(spell)) {
      this.move(spell.id, 'battlefield', { controller: spell.controller }); // CR 608.3
      onComplete();
      return;
    }
    const ctx = {
      controller: spell.controller, targets: legal, source: spell.sourceId, sourceCard: spell.sourceCard,
      sacrificedPower: spell.sacrificedPower, defender: spell.defender, lkiPower: spell.lkiPower,
      subject: spell.subject, amount: spell.amount, targetsByIndex: byIndex, subjectController: spell.subjectController,
    };
    this.runEffects(spell.effects || [], 0, ctx, () => {
      this.events.push({ type: 'resolve', card: spell.cardId, ability: spell.isAbility });
      done();
    });
  }

  // Esegue gli effetti in ordine; un effetto che richiede una scelta sospende la risoluzione finché il giocatore non decide
  runEffects(effects, start, ctx, finish) {
    for (let i = start; i < effects.length; i++) {
      const waiting = this.applyEffect(effects[i], ctx, () => this.runEffects(effects, i + 1, ctx, finish));
      if (waiting) return;
    }
    finish();
  }

  dealDamage(target, amount) {
    if (amount <= 0) return;
    if (target.player) this.state.get(target.player).life -= amount;
    else this.objects.get(target.object).damage += amount;
  }

  // Restituisce true se l'effetto ha chiesto una decisione: la risoluzione riprenderà con resume()
  applyEffect(effect, ctx, resume) {
    const s = this.state.get(ctx.controller);
    const source = this.objects.get(ctx.source);
    const sourceOnField = source && source.zone === 'battlefield';
    const eot = (id, mods) => this.eot.push({ id, ...mods });
    switch (effect.kind) {
      case 'damage': {
        const n = this.count(effect.amount, ctx);
        const opponents = this.players.filter((p) => p !== ctx.controller);
        let hit = ctx.targets;
        if (effect.to === 'eachOpponent') hit = opponents.map((p) => ({ player: p }));
        if (effect.to === 'eachPlayer') hit = this.players.map((p) => ({ player: p }));
        if (effect.to === 'you') hit = [{ player: ctx.controller }];
        if (effect.to === 'eachCreature') hit = this.battlefield().filter(isCreature).map((o) => ({ object: o.id }));
        if (effect.to === 'eachOpponentAndTheirCreatures') {
          hit = [...opponents.map((p) => ({ player: p })),
            ...this.battlefield().filter((o) => isCreature(o) && opponents.includes(o.controller)).map((o) => ({ object: o.id }))];
        }
        for (const t of hit) this.dealDamage(t, n);
        break;
      }
      case 'counter': // CR 701.6a
        for (const t of ctx.targets) {
          const spell = this.objects.get(t.object);
          const controller = spell.controller;
          this.move(spell.id, effect.toLibraryTop ? 'library' : 'graveyard', { top: effect.toLibraryTop });
          if (effect.token) this.createToken(controller, effect.token);
          if (effect.mill) this.mill(controller, effect.mill);
        }
        break;
      case 'bounce':
        for (const t of ctx.targets) {
          const o = this.objects.get(t.object);
          const wasYours = o.controller === ctx.controller;
          this.move(o.id, 'hand');
          if (effect.drawIfYours && wasYours) this.draw(ctx.controller, 1);
        }
        break;
      case 'bounceAll':
        for (const o of this.battlefield()) if (F.GROUP[effect.filter](this, o, {})) this.move(o.id, 'hand');
        break;
      case 'untapLands': { // "stappa fino a N terre": il motore sceglie le tue terre tappate
        const lands = this.battlefield().filter((o) => o.controller === ctx.controller && isType(o, 'Land') && o.tapped);
        for (const o of lands.slice(0, effect.amount)) o.tapped = false;
        break;
      }
      case 'poison':
        for (const p of this.players) if (p !== ctx.controller) this.state.get(p).poison += effect.amount;
        break;
      case 'mill':
        if (effect.who === 'you') this.mill(ctx.controller, effect.amount);
        else if (effect.who === 'eachPlayer') for (const p of this.players) this.mill(p, effect.amount);
        else for (const t of ctx.targets) if (t.player) this.mill(t.player, effect.amount);
        break;
      case 'may':
        this.ask({ type: 'confirm', player: ctx.controller, prompt: 'Vuoi applicare l\'effetto?',
          resume: (yes) => {
            if (!yes || !this.applyEffect(effect.effect, ctx, resume)) resume();
          } });
        return true;
      case 'scry': { // CR 701.22
        const cards = this.state.get(ctx.controller).zones.library.slice(0, effect.amount);
        this.ask({ type: 'scry', player: ctx.controller, cards, resume });
        return true;
      }
      case 'putBack':
        this.ask({ type: 'putBack', player: ctx.controller, count: Math.min(effect.amount, s.zones.hand.length), resume });
        return true;
      case 'discard': {
        const count = Math.min(effect.amount, s.zones.hand.length);
        if (!count) break;
        this.ask({ type: 'discard', player: ctx.controller, count, resume });
        return true;
      }
      case 'lookTop': {
        const options = s.zones.library.slice(0, effect.amount);
        if (!options.length) break;
        this.ask({ type: 'chooseCards', player: ctx.controller, options, count: Math.min(effect.take, options.length), rest: effect.rest, resume });
        return true;
      }
      case 'draw':
        this.draw(ctx.controller, this.count(effect.amount, ctx));
        break;
      case 'loseLife': {
        const n = this.count(effect.amount, ctx);
        if (effect.to === 'eachOpponent') for (const p of this.players) { if (p !== ctx.controller) this.state.get(p).life -= n; }
        else if (effect.to === 'subjectController') { if (this.isAlive(ctx.subjectController)) this.state.get(ctx.subjectController).life -= n; }
        else s.life -= n;
        break;
      }
      case 'drain': { // "you gain life equal to the life lost this way" = totale perso dagli avversari
        const n = this.count(effect.amount, ctx);
        const opponents = this.players.filter((p) => p !== ctx.controller);
        for (const p of opponents) this.state.get(p).life -= n;
        s.life += effect.gainTotal ? n * opponents.length : n;
        break;
      }
      case 'targetLosesYouGain':
        for (const t of ctx.targets) if (t.player) this.state.get(t.player).life -= effect.amount;
        s.life += effect.amount;
        break;
      case 'targetDrawsLoses':
        for (const t of ctx.targets) if (t.player) { this.draw(t.player, effect.draw); this.state.get(t.player).life -= effect.lose; }
        break;
      case 'exileGraveyard':
        for (const t of ctx.targets) if (t.player) for (const id of [...this.state.get(t.player).zones.graveyard]) this.move(id, 'exile');
        break;
      case 'destroyAll': {
        const all = this.battlefield().filter((o) => F.GROUP[effect.filter](this, o, {}));
        this.toGraveyard(all.filter((o) => !this.hasKw(o, 'Indestructible')));
        break;
      }
      case 'sacrificeAllColored':
        this.toGraveyard(this.battlefield().filter((o) => colorsOf(o.def).length > 0));
        break;
      case 'reanimate':
        for (const t of ctx.targets) {
          const card = this.objects.get(t.object);
          const mv = this.manaValue(card);
          this.move(card.id, 'battlefield', { controller: ctx.controller });
          if (effect.loseLifeMV) s.life -= mv;
        }
        break;
      case 'riseAll':
        for (const o of [...this.objects.values()]) if (o.zone === 'graveyard' && isCreature(o)) this.move(o.id, 'battlefield', { controller: ctx.controller });
        break;
      case 'livingDeath': { // CR 101.4: ogni passaggio avviene per tutti i giocatori insieme
        const exiled = [];
        for (const o of [...this.objects.values()]) if (o.zone === 'graveyard' && isCreature(o)) exiled.push(this.move(o.id, 'exile'));
        this.toGraveyard(this.battlefield().filter(isCreature));
        for (const id of exiled) if (this.objects.get(id)) this.move(id, 'battlefield');
        break;
      }
      case 'eachSacrifices':
        this.sacrificeRound(effect, ctx, resume);
        return true;
      case 'exhume':
        this.exhumeRound(ctx, resume);
        return true;
      case 'victimize': {
        const chosen = ctx.targetsByIndex.filter(Boolean).map((t) => t.object);
        const options = this.battlefield().filter((o) => o.controller === ctx.controller && isCreature(o)).map((o) => o.id);
        if (!options.length) break; // nessun sacrificio: le carte restano nel cimitero
        this.chooseSacrifice(ctx.controller, options, (id) => {
          this.toGraveyard([this.objects.get(id)]);
          for (const c of chosen) if (this.objects.get(c)?.zone === 'graveyard') this.move(c, 'battlefield', { tapped: true, controller: ctx.controller });
          resume();
        });
        return true;
      }
      case 'createToken': {
        const n = this.count(effect.count, ctx);
        for (let i = 0; i < n; i++) this.createToken(ctx.controller, effect.token);
        break;
      }
      case 'addMana':
        s.pool[effect.color] += this.count(effect.amount, ctx);
        break;
      case 'pump':
        for (const t of ctx.targets) eot(t.object, { power: effect.power, toughness: effect.toughness, keywords: effect.keywords });
        break;
      case 'pumpAll': { // l'insieme influenzato e la X si fissano alla risoluzione (CR 611.2c, 608.2h)
        const ref = { id: ctx.source, controller: ctx.controller };
        const power = this.count(effect.power || 0, ctx);
        const toughness = this.count(effect.toughness || 0, ctx);
        for (const o of this.battlefield().filter((x) => F.GROUP[effect.filter](this, x, ref))) eot(o.id, { power, toughness, keywords: effect.keywords });
        break;
      }
      case 'pumpSubject': {
        const o = this.objects.get(ctx.subject);
        if (o && o.zone === 'battlefield') eot(o.id, { keywords: effect.keywords });
        break;
      }
      case 'gainLife':
        s.life += this.count(effect.amount, ctx);
        break;
      case 'doubleCounters':
        for (const o of this.battlefield()) {
          if (o.controller === ctx.controller && isCreature(o) && o.counters['+1/+1']) o.counters['+1/+1'] *= 2;
        }
        break;
      case 'bite': { // la prima creatura infligge danno pari alla sua forza alla seconda (nessun danno di ritorno)
        const [mineT, theirsT] = ctx.targetsByIndex;
        const biter = mineT && this.objects.get(mineT.object);
        const victim = theirsT && this.objects.get(theirsT.object);
        if (biter && victim) {
          victim.damage += this.power(biter);
          if (this.hasKw(biter, 'Deathtouch') && this.power(biter) > 0) victim.deathtouched = true;
          if (this.hasKw(biter, 'Lifelink')) this.state.get(biter.controller).life += this.power(biter);
        }
        break;
      }
      case 'pumpSelf':
        if (sourceOnField) eot(source.id, { power: effect.power, toughness: effect.toughness });
        break;
      case 'cantBeBlocked':
        for (const t of ctx.targets) eot(t.object, { cantBeBlocked: true });
        break;
      case 'destroy': {
        const victims = ctx.targets.map((t) => this.objects.get(t.object));
        this.toGraveyard(victims.filter((o) => !this.hasKw(o, 'Indestructible')));
        if (effect.loseLifeMV) for (const o of victims) s.life -= this.manaValue(o);
        for (const o of victims) {
          if (effect.controllerToken) this.createToken(o.controller, effect.controllerToken);
          if (effect.controllerGainsLife) this.state.get(o.controller).life += effect.controllerGainsLife;
        }
        break;
      }
      case 'exile':
        for (const t of ctx.targets) this.move(t.object, 'exile');
        break;
      case 'putCounter': {
        const o = effect.on === 'subject' ? this.objects.get(ctx.subject) : source;
        if (o && o.zone === 'battlefield') o.counters['+1/+1'] = (o.counters['+1/+1'] || 0) + effect.amount;
        break;
      }
      case 'untapSelf':
        if (sourceOnField) source.tapped = false;
        break;
      case 'defenderRevealsTopLand': {
        const top = this.zone(ctx.defender, 'library')[0];
        if (top) {
          this.events.push({ type: 'reveal', player: ctx.defender, card: top.cardId });
          if (isType(top, 'Land')) this.move(top.id, 'hand');
        }
        break;
      }
      case 'revealTop': {
        const top = this.zone(ctx.controller, 'library').slice(0, effect.amount);
        this.events.push({ type: 'reveal', player: ctx.controller, cards: top.map((o) => o.cardId) });
        for (const o of top) {
          if (F.CARD[effect.filter](o)) this.move(o.id, 'hand');
          else this.move(o.id, 'library'); // in fondo, nell'ordine in cui erano
        }
        break;
      }
      case 'returnSelfToHand': {
        const back = () => { if (source && source.zone === 'graveyard') this.move(source.id, 'hand'); };
        if (!effect.optional) { back(); break; }
        this.ask({ type: 'confirm', player: ctx.controller, prompt: `Riprendere ${source?.name ?? 'la carta'} in mano?`,
          resume: (yes) => { if (yes) back(); resume(); } });
        return true;
      }
      case 'search': { // la ricerca può non trovare nulla (CR 701.23); poi si mescola
        const options = this.zone(ctx.controller, 'library').filter((o) => F.CARD[effect.filter](o)).map((o) => o.id);
        this.ask({ type: 'search', player: ctx.controller, options, max: effect.max || 1,
          resume: (ids) => {
            ids.forEach((id, i) => { // con split la prima carta va nella prima destinazione, le altre nella seconda
              const to = effect.split ? effect.split[Math.min(i, effect.split.length - 1)] : effect.to;
              if (to === 'battlefieldTapped') this.move(id, 'battlefield', { tapped: true });
              else if (to !== 'libraryTop') this.move(id, to);
            });
            const lib = this.state.get(ctx.controller).zones.library;
            this.rng.shuffle(lib);
            if (effect.to === 'libraryTop') for (const id of ids) { lib.splice(lib.indexOf(id), 1); lib.unshift(id); } // Vampiric Tutor
            resume();
          } });
        return true;
      }
      default:
        throw new Error(`Effetto non supportato: ${effect.kind}`);
    }
    return false;
  }

  // ---------- Azioni dei giocatori ----------
  perform(pid, action) {
    if (this.decision) {
      if (this.decision.player !== pid || this.decision.type !== action.type) {
        throw new RuleError('DECISION_PENDING', 'Prima va presa la decisione in corso');
      }
      this.actions[action.type].call(this, pid, action);
      return;
    }
    if (this.priority !== pid) throw new RuleError('NO_PRIORITY', 'Non hai la priorità in questo momento');
    if (!['pass', 'activateMana', 'playLand', 'cast', 'activate'].includes(action.type)) {
      throw new RuleError('NOT_NOW', 'Questa azione non è possibile adesso');
    }
    this.actions[action.type].call(this, pid, action);
    if (action.type !== 'pass' && !this.decision) {
      this.passes = 0; // dopo un'azione la priorità resta a chi ha agito (CR 117.3c)
      this.givePriority(pid);
    }
  }

  // Verifica un'azione senza eseguirla: si prova su una copia dello stato e poi si ripristina tutto.
  // Si usa solo quando il giocatore ha la priorità (nessuna decisione o innesco in sospeso).
  check(pid, action) {
    if (this.decision) return { ok: false, code: 'DECISION_PENDING', message: 'Prima va presa la decisione in corso' };
    const saved = this.saveState();
    try {
      this.perform(pid, action);
      return { ok: true };
    } catch (e) {
      if (!(e instanceof RuleError)) throw e;
      return { ok: false, code: e.code, message: e.message };
    } finally {
      this.restoreState(saved);
    }
  }

  saveState() {
    const copyObj = (o) => ({ ...o, counters: { ...o.counters }, targets: o.targets.map((t) => ({ ...t })) });
    return {
      objects: new Map([...this.objects].map(([k, o]) => [k, copyObj(o)])),
      state: new Map([...this.state].map(([k, s]) => [k, {
        ...s,
        pool: { ...s.pool },
        commanderCasts: { ...s.commanderCasts },
        commanderDamage: { ...s.commanderDamage },
        preferences: { ...s.preferences },
        zones: Object.fromEntries(Object.entries(s.zones).map(([z, ids]) => [z, [...ids]])),
      }])),
      scalars: {
        nextId: this.nextId, stackIds: [...this.stackIds], winner: this.winner, decision: this.decision,
        pendingTriggers: [...this.pendingTriggers], triggerQueue: [...this.triggerQueue], eot: this.eot.map((e) => ({ ...e })),
        enteredThisTurn: { ...this.enteredThisTurn }, onceThisTurn: new Set(this.onceThisTurn), turn: this.turn, active: this.active,
        step: this.step, priority: this.priority, passes: this.passes, resumePid: this.resumePid,
        pendingDefenders: this.pendingDefenders && [...this.pendingDefenders],
        combat: this.combat && {
          attackers: new Map([...this.combat.attackers].map(([k, a]) => [k, { ...a, blockers: [...a.blockers] }])),
          dealtFirst: new Set(this.combat.dealtFirst),
        },
      },
      events: this.events.length,
      rng: this.rng.getState(),
    };
  }

  restoreState(saved) {
    this.objects = saved.objects;
    this.state = saved.state;
    Object.assign(this, saved.scalars);
    this.events.length = saved.events;
    this.rng.setState(saved.rng);
  }

  ownCard(pid, id, zones) {
    const o = this.objects.get(id);
    if (!o || o.owner !== pid || !zones.includes(o.zone)) throw new RuleError('NOT_AVAILABLE', 'Questa carta non è disponibile per te');
    return o;
  }

  sorceryTiming(pid) {
    return this.active === pid && MAIN_STEPS.has(this.step) && this.stackIds.length === 0; // CR 307.1
  }

  // Verifica i costi di sacrificio e scarto senza modificare nulla; restituisce gli oggetti da usare
  checkExtraCosts(pid, spec, action, src) {
    const sacrifice = (action.sacrifice || []).map((id) => this.objects.get(id));
    const discard = (action.discard || []).map((id) => this.objects.get(id));
    if (spec.sacrifice) {
      const ok = sacrifice.length === 1 && sacrifice[0] && sacrifice[0].zone === 'battlefield'
        && F.SACRIFICE[spec.sacrifice](this, sacrifice[0], pid, src);
      if (!ok) throw new RuleError('MISSING_COST', `Per pagare il costo devi sacrificare ${spec.sacrifice === 'self' ? 'questo permanente' : `un ${{ goblin: 'Goblin', creature: 'creatura' }[spec.sacrifice]} che controlli`}`);
    } else if (sacrifice.length) throw new RuleError('MISSING_COST', 'Questo costo non prevede sacrifici');
    if (spec.discard) {
      const ok = discard.length === spec.discard && new Set(discard).size === discard.length
        && discard.every((o) => o && o.owner === pid && o.zone === 'hand' && (!src || o.id !== src.id));
      if (!ok) throw new RuleError('MISSING_COST', `Per pagare il costo devi scartare ${spec.discard} carta`);
    } else if (discard.length) throw new RuleError('MISSING_COST', 'Questo costo non prevede scarti');
    return { sacrifice, discard };
  }

  checkTargets(kind, targets, pid, what, kinds = null) {
    if (kinds) {
      if (targets.length !== kinds.length) throw new RuleError('NEEDS_TARGET', `${what} richiede ${kinds.length} bersagli`);
      targets.forEach((t, i) => { if (!this.targetIsLegal(kinds[i], t, pid)) throw new RuleError('INVALID_TARGET', `Bersaglio ${i + 1} non valido per ${what}`); });
      return;
    }
    if (kind && !targets.length) throw new RuleError('NEEDS_TARGET', `${what} richiede un bersaglio`);
    if (!kind && targets.length) throw new RuleError('INVALID_TARGET', `${what} non ha bersagli`);
    for (const t of targets) if (!this.targetIsLegal(kind, t, pid)) throw new RuleError('INVALID_TARGET', `Bersaglio non valido per ${what}`);
  }

  // Pagamento automatico (CR 601.2g-h: si attivano abilità di mana prima di pagare). Prima si calcola un piano completo,
  // poi lo si esegue: se il mana non basta non si tappa nulla. Ordine di preferenza: terre di un colore, altre fonti fisse,
  // fonti di qualsiasi colore, infine creature. Le fonti con altri costi (sacrificio, mana) restano escluse.
  autoTap(pid, cost, exclude) {
    const s = this.state.get(pid);
    const sources = [];
    for (const o of this.battlefield()) {
      if (o.controller !== pid || exclude.has(o.id) || o.tapped || this.isSick(o)) continue;
      const a = (o.def.abilities || []).find((x) => x.kind === 'mana');
      if (!a || a.cost !== '{T}' || a.sacrifice) continue;
      const times = a.amount ? this.count(a.amount, { controller: pid, source: o.id }) : 1;
      const flexible = a.produce === 'anyColor' ? WUBRG : a.produce === 'commanderIdentity' ? s.identity : null;
      if (flexible && !flexible.length) continue;
      const rank = (isCreature(o) ? 10 : 0) + (flexible ? 2 : isType(o, 'Land') && a.produce.length === 1 ? 0 : 1);
      sources.push({ id: o.id, produce: flexible ? null : a.produce, flexible, times, rank });
    }
    sources.sort((x, y) => x.rank - y.rank);
    const sim = { ...s.pool };
    const plan = [];
    const use = (src, color) => {
      plan.push({ object: src.id, color });
      sources.splice(sources.indexOf(src), 1);
      for (const c of src.produce || color) sim[c] += src.times;
    };
    for (const c of COLORS) {
      while (sim[c] < cost[c]) {
        const src = sources.find((x) => (x.produce ? x.produce.includes(c) : x.flexible.includes(c)));
        if (!src) return null;
        use(src, src.produce ? undefined : c);
      }
    }
    while (!canPay(sim, cost)) {
      const src = sources[0];
      if (!src) return null;
      use(src, src.produce ? undefined : src.flexible[0]);
    }
    return plan;
  }

  payAutomatically(pid, cost, exclude) {
    const plan = this.autoTap(pid, cost, exclude);
    if (!plan) throw new RuleError('NOT_ENOUGH_MANA', `Non hai abbastanza fonti di mana stappate per pagare ${formatCost(cost)}`);
    for (const step of plan) this.actions.activateMana.call(this, pid, step);
  }

  // Inneschi "quando lanci una magia" (CR 603.2)
  onCast(spell) {
    for (const w of this.battlefield()) {
      for (const a of this.triggersOf(w, 'castSpell')) if (F.TRIGGER[a.filter](this, spell, w)) this.queueTrigger(w, a);
    }
  }
}

Game.prototype.actions = {
  pass() {
    this.passes++;
    if (this.passes < this.players.length) {
      this.givePriority(this.nextPlayer(this.priority));
      return;
    }
    if (this.stackIds.length) { // tutti hanno passato: si risolve la cima della Pila (CR 117.4)
      this.priority = null;
      this.resolveTop(() => {
        this.passes = 0;
        this.givePriority(this.active); // CR 117.3b
      });
    } else {
      this.endStep();
    }
  },

  activateMana(pid, action) {
    const o = this.objects.get(action.object);
    if (!o || o.zone !== 'battlefield' || o.controller !== pid) throw new RuleError('NOT_YOURS', 'Non controlli questo permanente');
    const ability = (o.def.abilities || []).find((a) => a.kind === 'mana');
    if (!ability) throw new RuleError('NO_MANA_ABILITY', `${o.name} non produce mana`);
    const tap = ability.cost.includes('{T}');
    if (tap && o.tapped) throw new RuleError('TAPPED', `${o.name} è già tappato`);
    if (tap && this.isSick(o)) throw new RuleError('SUMMONING_SICK', `${o.name} è entrata in questo turno: non può usare abilità con {T}`);
    let produce = ability.produce;
    if (produce === 'commanderIdentity' || produce === 'anyColor') {
      const allowed = produce === 'anyColor' ? WUBRG : this.state.get(pid).identity;
      if (!allowed.includes(action.color)) {
        throw new RuleError('INVALID_COLOR', allowed.length ? `Scegli un colore tra ${allowed.join(', ')}` : 'Il tuo comandante non ha colori: non si produce mana');
      }
      produce = action.color;
    }
    const { sacrifice } = this.checkExtraCosts(pid, ability, action, o);
    const manaCost = parseCost(ability.cost.replace(/\{T\}/g, ''));
    const s = this.state.get(pid);
    if (!canPay(s.pool, manaCost)) throw new RuleError('NOT_ENOUGH_MANA', `Servono ${formatCost(manaCost)} per attivare ${o.name}`);
    const times = ability.amount ? this.count(ability.amount, { controller: pid, source: o.id }) : 1;
    s.pool = pay(s.pool, manaCost);
    if (tap) o.tapped = true;
    if (sacrifice.length) this.toGraveyard(sacrifice);
    for (const c of produce) this.state.get(pid).pool[c] += times;
  },

  playLand(pid, { object }) {
    const o = this.ownCard(pid, object, ['hand']);
    if (!isType(o, 'Land')) throw new RuleError('NOT_A_LAND', `${o.name} non è una terra`);
    if (!this.sorceryTiming(pid)) throw new RuleError('SORCERY_TIMING', 'Le terre si giocano solo nella tua fase principale, con la Pila vuota');
    const s = this.state.get(pid);
    const extra = this.battlefield().filter((x) => x.controller === pid).reduce((n, x) => n + ((x.def.abilities || [])
      .filter((a) => a.kind === 'static' && a.extraLandPlays).reduce((m, a) => m + a.extraLandPlays, 0)), 0);
    if (s.landsPlayed >= 1 + extra) throw new RuleError('LAND_ALREADY_PLAYED', 'Hai già giocato tutte le terre consentite in questo turno'); // CR 305.2
    s.landsPlayed++;
    this.move(o.id, 'battlefield');
  },

  cast(pid, action) {
    const { object, targets = [] } = action;
    const o = this.ownCard(pid, object, ['hand', 'command']);
    if (isType(o, 'Land')) throw new RuleError('LAND_NOT_CAST', 'Le terre si giocano, non si lanciano');
    if (!isType(o, 'Instant') && !this.hasKw(o, 'Flash') && !this.sorceryTiming(pid)) { // CR 702.8a
      throw new RuleError('SORCERY_TIMING', `${o.name} si può lanciare solo nella tua fase principale, con la Pila vuota`);
    }
    let effects = [].concat(o.def.effect || []);
    if (o.def.modes) { // CR 700.2
      if (!Number.isInteger(action.mode) || !o.def.modes[action.mode]) throw new RuleError('NEEDS_MODE', `Scegli una modalità per ${o.name}`);
      effects = [o.def.modes[action.mode]];
    }
    const kind = targetKindOf(effects);
    const kinds = targetKindsOf(effects);
    this.checkTargets(kind, targets, pid, o.name, kinds);
    const { sacrifice, discard } = this.checkExtraCosts(pid, o.def.additionalCost || {}, action, o);
    const s = this.state.get(pid);
    const cost = this.totalCost(pid, o);
    if (!canPay(s.pool, cost) && action.autoPay) this.payAutomatically(pid, cost, new Set([o.id, ...sacrifice.map((x) => x.id)]));
    if (!canPay(s.pool, cost)) throw new RuleError('NOT_ENOUGH_MANA', `Servono ${formatCost(cost)} per lanciare ${o.name}`);
    // da qui in poi l'azione è legale: si paga e la magia va sulla Pila
    s.pool = pay(s.pool, cost);
    if (o.zone === 'command') s.commanderCasts[o.cardId] = (s.commanderCasts[o.cardId] || 0) + 1;
    const sacrificedPower = sacrifice.length ? this.power(sacrifice[0]) : undefined;
    if (sacrifice.length) this.toGraveyard(sacrifice);
    for (const d of discard) this.move(d.id, 'graveyard');
    const id = this.move(o.id, 'stack', { targets });
    const spell = this.objects.get(id);
    Object.assign(spell, { effects, targetKind: kind, targetKinds: kinds, sacrificedPower, controller: pid });
    this.onCast(spell);
  },

  // Abilità attivate non di mana (CR 602): il costo può contenere {T}, mana, sacrifici e scarti
  activate(pid, action) {
    const { object, ability = 0, targets = [] } = action;
    const o = this.objects.get(object);
    if (!o || o.zone !== 'battlefield' || o.controller !== pid) throw new RuleError('NOT_YOURS', 'Non controlli questo permanente');
    const ab = (o.def.abilities || []).filter((a) => a.kind === 'activated')[ability];
    if (!ab) throw new RuleError('NO_ABILITY', `${o.name} non ha questa abilità`);
    const tap = ab.cost.includes('{T}');
    if (tap && o.tapped) throw new RuleError('TAPPED', `${o.name} è già tappato`);
    if (tap && this.isSick(o)) throw new RuleError('SUMMONING_SICK', `${o.name} è entrata in questo turno: non può usare abilità con {T}`);
    const effects = [].concat(ab.effect);
    this.checkTargets(targetKindOf(effects), targets, pid, `L'abilità di ${o.name}`);
    const { sacrifice, discard } = this.checkExtraCosts(pid, ab, action, o);
    const s = this.state.get(pid);
    const cost = parseCost(ab.cost.replace(/\{T\}/g, ''));
    if (!canPay(s.pool, cost) && action.autoPay) this.payAutomatically(pid, cost, new Set([o.id, ...sacrifice.map((x) => x.id)]));
    if (!canPay(s.pool, cost)) throw new RuleError('NOT_ENOUGH_MANA', `Servono ${formatCost(cost)} per attivare l'abilità di ${o.name}`);
    s.pool = pay(s.pool, cost);
    if (tap) o.tapped = true;
    const lkiPower = isCreature(o) ? this.power(o) : 0;
    for (const d of discard) this.move(d.id, 'graveyard');
    if (sacrifice.length) this.toGraveyard(sacrifice);
    this.putAbilityOnStack(pid, o, effects, targets, { lkiPower });
  },

  discard(pid, { objects = [] }) {
    const d = this.decision;
    const hand = this.state.get(pid).zones.hand;
    const unique = new Set(objects);
    if (unique.size !== d.count || objects.length !== unique.size || objects.some((id) => !hand.includes(id))) {
      throw new RuleError('INVALID_DISCARD', `Devi scartare esattamente ${d.count} carte dalla tua mano`);
    }
    for (const id of objects) this.move(id, 'graveyard');
    this.decision = null;
    if (d.resume) d.resume(); // scarto chiesto da un effetto
    else this.endStep(); // scarto di fine turno (CR 514.1)
  },

  scry(pid, { top = [], bottom = [] }) {
    const d = this.decision;
    const all = [...top, ...bottom];
    if (all.length !== d.cards.length || new Set(all).size !== all.length || all.some((id) => !d.cards.includes(id))) {
      throw new RuleError('INVALID_CHOICE', 'Ogni carta guardata va messa in cima o in fondo, una sola volta');
    }
    const lib = this.state.get(pid).zones.library;
    lib.splice(0, d.cards.length);
    lib.unshift(...top);
    lib.push(...bottom);
    this.decision = null;
    d.resume();
  },

  putBack(pid, { objects = [] }) {
    const d = this.decision;
    const hand = this.state.get(pid).zones.hand;
    if (objects.length !== d.count || new Set(objects).size !== objects.length || objects.some((id) => !hand.includes(id))) {
      throw new RuleError('INVALID_CHOICE', `Scegli ${d.count} carte dalla tua mano`);
    }
    this.decision = null;
    if (d.bottom) {
      const mark = this.events.length;
      for (const id of objects) this.move(id, 'library', { manual: true }); // in fondo, senza rivelarle nel registro
      this.events.length = mark;
      d.resume();
      return;
    }
    for (const id of [...objects].reverse()) this.move(id, 'library', { top: true }); // la prima scelta finisce in cima
    d.resume();
  },

  chooseCards(pid, { objects = [] }) {
    const d = this.decision;
    if (objects.length !== d.count || new Set(objects).size !== objects.length || objects.some((id) => !d.options.includes(id))) {
      throw new RuleError('INVALID_CHOICE', `Scegli ${d.count} carte tra quelle indicate`);
    }
    this.decision = null;
    if (d.keep) return d.resume(objects); // la scelta la usa chi l'ha chiesta (Exhume)
    for (const id of objects) this.move(id, 'hand');
    for (const id of d.options.filter((x) => !objects.includes(x))) this.move(id, d.rest === 'graveyard' ? 'graveyard' : 'library'); // in fondo
    d.resume();
  },

  chooseSacrifice(pid, { object }) {
    const d = this.decision;
    if (!d.options.includes(object)) throw new RuleError('INVALID_CHOICE', 'Scegli una delle tue creature da sacrificare');
    this.decision = null;
    d.resume(object);
  },

  chooseTarget(pid, { target }) {
    const d = this.decision;
    if (target == null) {
      if (!d.optional) throw new RuleError('NEEDS_TARGET', 'Questa abilità richiede un bersaglio');
    } else if (!d.options.some((t) => sameTarget(t, target))) {
      throw new RuleError('INVALID_TARGET', 'Bersaglio non valido');
    }
    this.decision = null;
    if (target != null) this.putTriggerOnStack(d.trigger, [target]);
    this.givePriority(this.resumePid);
  },

  // assignment: { idBloccante: danni }; la somma deve fare tutta la forza dell'attaccante (CR 510.1c, 510.1e)
  assignDamage(pid, { assignment = {} }) {
    const d = this.decision;
    const values = d.blockers.map((b) => assignment[b.id] ?? 0);
    if (values.some((n) => !Number.isInteger(n) || n < 0) || values.reduce((a, n) => a + n, 0) !== d.power) {
      throw new RuleError('INVALID_CHOICE', `Devi assegnare esattamente ${d.power} danni`);
    }
    this.decision = null;
    d.resume(Object.fromEntries(d.blockers.map((b, i) => [b.id, values[i]])));
  },

  // order: gli indici degli inneschi nell'ordine in cui si risolveranno, dal primo all'ultimo
  orderTriggers(pid, { order = [] }) {
    const d = this.decision;
    const n = d.group.length;
    if (order.length !== n || new Set(order).size !== n || order.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) {
      throw new RuleError('INVALID_CHOICE', 'Indica un ordine per ogni abilità');
    }
    this.decision = null;
    // chi si risolve per primo deve stare in cima alla Pila, quindi va messo per ultimo (CR 405.2)
    d.resume([...order].reverse().map((i) => d.group[i]));
    this.givePriority(this.resumePid);
  },

  confirm(pid, { yes }) {
    const d = this.decision;
    this.decision = null;
    d.resume(!!yes);
  },

  search(pid, { object, objects }) {
    const d = this.decision;
    const ids = objects ?? (object != null ? [object] : []);
    if (ids.length > d.max || new Set(ids).size !== ids.length || ids.some((id) => !d.options.includes(id))) {
      throw new RuleError('INVALID_CHOICE', `Puoi scegliere al massimo ${d.max} carte tra quelle valide`);
    }
    this.decision = null;
    d.resume(ids);
  },
};

module.exports = { Game, STEPS };

// Il combattimento vive in un modulo a parte ma agisce sullo stesso stato
require('./combat').install(Game);
