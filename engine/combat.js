// Combattimento (CR 506-511): attaccanti, bloccanti, danno, keyword di combattimento.
const { RuleError } = require('./errors');
const { isCreature, TRIGGER } = require('./filters');

class Combat {
  isSick(o) {
    return isCreature(o) && o.controlSince >= this.state.get(o.controller).lastTurnStart && !this.hasKw(o, 'Haste');
  }

  isFirstStriker(o) {
    return this.hasKw(o, 'First strike') || this.hasKw(o, 'Double strike');
  }

  // Motivo per cui una creatura non può attaccare, oppure null (CR 508.1a)
  attackProblem(o) {
    if (o.zone !== 'battlefield' || o.controller !== this.active || !isCreature(o)) return ['NOT_YOURS', 'Puoi attaccare solo con le tue creature'];
    if (this.hasKw(o, 'Defender')) return ['CANT_ATTACK', `${o.name} ha Difensore e non può attaccare`];
    if (o.tapped) return ['TAPPED', `${o.name} è tappata`];
    if (this.isSick(o)) return ['SUMMONING_SICK', `${o.name} è entrata in questo turno e non può ancora attaccare`];
    return null;
  }

  // Motivo per cui un bloccante non può bloccare quell'attaccante, oppure null (CR 509.1b)
  blockProblem(b, att, defender) {
    if (this.cantBeBlocked(att)) return `${att.name} non può essere bloccata in questo turno`;
    if (this.hasKw(att, 'Mountainwalk') && this.battlefield().some((o) => o.controller === defender && (o.def.subtypes || []).includes('Mountain'))) {
      return `${att.name} ha Passaterre (Mountain) e tu controlli una Mountain`; // CR 702.14c
    }
    if (this.hasKw(att, 'Flying') && !this.hasKw(b, 'Flying') && !this.hasKw(b, 'Reach')) {
      return `${att.name} ha Volare: si blocca solo con Volare o Raggiungere`; // CR 702.9b
    }
    return null;
  }

  // Giocatori attaccati, in ordine di turno a partire dal giocatore attivo (CR 509.1)
  defendersInOrder() {
    const attacked = new Set([...this.combat.attackers.values()].map((a) => a.defender));
    return this.players.filter((pid) => attacked.has(pid));
  }

  askNextDefender() {
    while (this.pendingDefenders.length) {
      const pid = this.pendingDefenders.shift();
      const canBlock = this.battlefield().some((o) => o.controller === pid && isCreature(o) && !o.tapped);
      if (canBlock) return this.ask({ type: 'declareBlockers', player: pid });
    }
    this.decision = null;
    this.givePriority(this.active);
  }

  combatants() {
    if (!this.combat) return [];
    const ids = new Set();
    for (const [id, a] of this.combat.attackers) {
      ids.add(id);
      for (const b of a.blockers) ids.add(b);
    }
    return [...ids].map((id) => this.objects.get(id)).filter((o) => o && o.zone === 'battlefield');
  }

  dealsDamageNow(o, firstStep) {
    if (firstStep) return this.isFirstStriker(o);
    return !this.combat.dealtFirst.has(o.id) || this.hasKw(o, 'Double strike'); // CR 510.4
  }

  lethalDamage(source, target) {
    return this.hasKw(source, 'Deathtouch') ? 1 : Math.max(0, this.toughness(target) - target.damage);
  }

  // CR 510.1c: chi attacca divide il danno tra i bloccanti. Si chiede solo quando la forza non basta per
  // ucciderli tutti: negli altri casi l'assegnazione automatica è già la migliore.
  askDamageAssignments(firstStep) {
    if (!this.askDamage) return false;
    const needed = [];
    for (const [id, a] of this.combat.attackers) {
      const att = this.objects.get(id);
      if (!att || att.zone !== 'battlefield' || !this.dealsDamageNow(att, firstStep)) continue;
      const blockers = a.blockers.map((b) => this.objects.get(b)).filter((b) => b && b.zone === 'battlefield');
      const power = this.power(att);
      const total = blockers.reduce((sum, b) => sum + this.lethalDamage(att, b), 0);
      if (blockers.length > 1 && power > 0 && power < total) needed.push({ att, blockers, power });
    }
    if (!needed.length) return false;
    this.combat.assignments = new Map();
    const next = (i) => {
      if (i === needed.length) {
        this.dealCombatDamage(firstStep);
        this.givePriority(this.active);
        return;
      }
      const { att, blockers, power } = needed[i];
      this.ask({
        type: 'assignDamage', player: att.controller, attacker: att.id, attackerName: att.name, power,
        blockers: blockers.map((b) => ({ id: b.id, name: b.name, lethal: this.lethalDamage(att, b) })),
        resume: (assignment) => {
          this.combat.assignments.set(att.id, assignment);
          next(i + 1);
        },
      });
    };
    next(0);
    return true;
  }

  // Danno da combattimento (CR 510): tutto il danno di un passo viene inflitto contemporaneamente
  dealCombatDamage(firstStep) {
    const dealsNow = (o) => this.dealsDamageNow(o, firstStep);
    const alive = (o) => o && o.zone === 'battlefield';
    const hits = [];
    const lethal = (source, target) => this.lethalDamage(source, target);
    for (const [id, a] of this.combat.attackers) {
      const att = this.objects.get(id);
      const power = alive(att) ? this.power(att) : 0;
      if (!alive(att) || !dealsNow(att) || power <= 0) continue;
      const blockers = a.blockers.map((b) => this.objects.get(b)).filter(alive);
      if (!a.blocked) {
        hits.push({ source: att, player: a.defender, amount: power });
        continue;
      }
      // Divisione scelta dal giocatore, oppure automatica: danno letale a ogni bloccante, il resto al giocatore se ha Travolgere
      const chosen = this.combat.assignments?.get(id);
      let left = chosen ? 0 : power;
      const given = new Map();
      if (chosen) for (const b of blockers) given.set(b, chosen[b.id] || 0);
      else for (const b of blockers) {
        const n = Math.min(left, lethal(att, b));
        given.set(b, n);
        left -= n;
      }
      if (left > 0 && this.hasKw(att, 'Trample')) hits.push({ source: att, player: a.defender, amount: left }); // CR 702.19b
      else if (left > 0 && blockers.length) given.set(blockers.at(-1), given.get(blockers.at(-1)) + left);
      for (const [b, n] of given) if (n > 0) hits.push({ source: att, object: b, amount: n });
    }
    for (const [id, a] of this.combat.attackers) {
      const att = this.objects.get(id);
      if (!alive(att)) continue;
      for (const bid of a.blockers) {
        const b = this.objects.get(bid);
        const power = alive(b) ? this.power(b) : 0;
        if (alive(b) && dealsNow(b) && power > 0) hits.push({ source: b, object: att, amount: power });
      }
    }
    // Fog Bank: il danno da combattimento inflitto a e da essa viene prevenuto (CR 615)
    const prevented = (o) => o && this.hasStatic(o, 'preventCombatDamage');
    for (let i = hits.length - 1; i >= 0; i--) if (prevented(hits[i].source) || prevented(hits[i].object)) hits.splice(i, 1);
    // le keyword della fonte si leggono prima di applicare il danno
    const kw = new Map(hits.map((h) => [h.source, { deathtouch: this.hasKw(h.source, 'Deathtouch'), lifelink: this.hasKw(h.source, 'Lifelink') }]));
    for (const h of hits) {
      if (firstStep) this.combat.dealtFirst.add(h.source.id);
      if (h.player) {
        const s = this.state.get(h.player);
        s.life -= h.amount;
        if (h.source.isCommander) s.commanderDamage[h.source.cardId] = (s.commanderDamage[h.source.cardId] || 0) + h.amount;
      } else {
        h.object.damage += h.amount;
        if (kw.get(h.source).deathtouch) h.object.deathtouched = true;
      }
      if (kw.get(h.source).lifelink) this.state.get(h.source.controller).life += h.amount; // CR 702.15b
      this.events.push({ type: 'combatDamage', source: h.source.cardId, name: h.source.name, player: h.player, object: h.object?.id, target: h.object?.name, amount: h.amount });
    }
    if (this.combat.assignments) this.combat.assignments.clear();
    // Inneschi "quando infligge danno da combattimento a un giocatore" (della creatura stessa o di chi la osserva)
    for (const h of hits) {
      if (!h.player) continue;
      for (const a of this.triggersOf(h.source, 'combatDamageToPlayer')) if (!a.filter) this.queueTrigger(h.source, a, { amount: h.amount });
      for (const w of this.battlefield()) {
        for (const a of this.triggersOf(w, 'combatDamageToPlayer')) {
          if (a.filter && TRIGGER[a.filter](this, h.source, w)) this.queueTrigger(w, a, { amount: h.amount, subject: h.source.id });
        }
      }
    }
  }
}

const actions = {
  declareAttackers(pid, { attackers = [] }) {
    const seen = new Set();
    for (const { object, defender } of attackers) {
      const o = this.objects.get(object);
      const problem = o ? this.attackProblem(o) : ['NOT_YOURS', 'Creatura non trovata'];
      if (problem) throw new RuleError(...problem);
      if (seen.has(object)) throw new RuleError('DUPLICATE', `${o.name} è già tra gli attaccanti`);
      if (defender === pid || !this.players.includes(defender)) throw new RuleError('INVALID_DEFENDER', 'Puoi attaccare solo un avversario ancora in partita');
      seen.add(object);
    }
    for (const { object, defender } of attackers) {
      const o = this.objects.get(object);
      if (!this.hasKw(o, 'Vigilance')) o.tapped = true; // CR 508.1f, 702.20b
      this.combat.attackers.set(object, { defender, blockers: [], blocked: false });
    }
    for (const { object, defender } of attackers) { // inneschi "quando attacca" (CR 508.3a)
      const o = this.objects.get(object);
      for (const a of this.triggersOf(o, 'attacks')) this.queueTrigger(o, a, { defender });
    }
    this.decision = null;
    this.givePriority(this.active);
  },

  declareBlockers(pid, { blocks = [] }) {
    const used = new Set();
    for (const { blocker, attacker } of blocks) {
      const b = this.objects.get(blocker);
      const a = this.combat.attackers.get(attacker);
      const att = this.objects.get(attacker);
      if (!b || b.zone !== 'battlefield' || b.controller !== pid || !isCreature(b)) throw new RuleError('INVALID_BLOCK', 'Puoi bloccare solo con le tue creature');
      if (b.tapped) throw new RuleError('INVALID_BLOCK', `${b.name} è tappata e non può bloccare`);
      if (this.hasStatic(b, 'cantBlock')) throw new RuleError('INVALID_BLOCK', `${b.name} non può bloccare`);
      if (!a || a.defender !== pid) throw new RuleError('INVALID_BLOCK', 'Puoi bloccare solo creature che attaccano te');
      if (used.has(blocker)) throw new RuleError('INVALID_BLOCK', `${b.name} sta già bloccando`);
      const problem = this.blockProblem(b, att, pid);
      if (problem) throw new RuleError('INVALID_BLOCK', problem);
      used.add(blocker);
    }
    for (const [id] of this.combat.attackers) {
      const n = blocks.filter((x) => x.attacker === id).length;
      if (n === 1 && this.hasKw(this.objects.get(id), 'Menace')) {
        throw new RuleError('INVALID_BLOCK', `${this.objects.get(id).name} ha Minacciare: servono almeno due bloccanti`);
      }
    }
    for (const { blocker, attacker } of blocks) {
      const a = this.combat.attackers.get(attacker);
      a.blockers.push(blocker);
      a.blocked = true; // resta bloccata anche se i bloccanti spariscono (CR 509.1h)
    }
    this.askNextDefender();
  },
};

function install(Game) {
  for (const name of Object.getOwnPropertyNames(Combat.prototype)) {
    if (name !== 'constructor') Game.prototype[name] = Combat.prototype[name];
  }
  Object.assign(Game.prototype.actions, actions);
}

module.exports = { install };
