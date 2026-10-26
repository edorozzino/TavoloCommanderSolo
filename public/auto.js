// Tavolo con regole automatiche: il motore sul server applica le regole, qui si mostra la sua vista e si raccolgono le scelte.
(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const CT = window.CT;
  const esc = CT.esc;
  const toast = CT.toast;

  const STEPS = [
    ['upkeep', 'Mantenimento'], ['draw', 'Acquisizione'], ['main1', 'Principale 1'], ['beginCombat', 'Inizio combattimento'],
    ['declareAttackers', 'Attaccanti'], ['declareBlockers', 'Bloccanti'], ['combatDamage', 'Danno'], ['endCombat', 'Fine combattimento'],
    ['main2', 'Principale 2'], ['end', 'Finale'],
  ];
  const KW = {
    Flying: 'Volare', Trample: 'Travolgere', Haste: 'Rapidità', Vigilance: 'Cautela', Deathtouch: 'Tocco letale', Lifelink: 'Legame vitale',
    'First strike': 'Attacco improvviso', 'Double strike': 'Doppio attacco', Menace: 'Minacciare', Reach: 'Raggiungere', Hexproof: 'Anti-malocchio',
    Indestructible: 'Indistruttibile', Defender: 'Difensore', Unblockable: 'Non bloccabile', Mountainwalk: 'Passaterre (Mountain)', Flash: 'Lampo',
  };
  const DECISION_NAMES = {
    declareAttackers: 'dichiarare gli attaccanti', declareBlockers: 'dichiarare i bloccanti', discard: 'scartare', chooseTarget: 'scegliere un bersaglio',
    confirm: 'decidere', search: 'cercare nel grimorio', scry: 'profetizzare', putBack: 'rimettere carte in cima', chooseCards: 'scegliere delle carte',
    chooseSacrifice: 'scegliere cosa sacrificare',
  };

  let session = CT.store.get('ct-auto-session'); // { name, room, pid }
  let M = null; // ultimo messaggio autoState
  let flow = null; // azione in costruzione: { action, steps, i, title, picked }
  let attack = null; // dichiarazione degli attaccanti in corso
  let block = null; // dichiarazione dei bloccanti in corso
  let picks = []; // carte scelte per scarti, rimesse in cima, ricerche
  let scryBottom = new Set();
  let lessonList = null; // elenco delle lezioni dell'Accademia
  // Schermata compatta (telefoni): avversario mostrato in grande, carta sollevata dalla mano, carta in anteprima
  let focusId = null;
  let lastActive = null;
  let raised = null;
  let previewId = null;
  let introShown = null; // lezione di cui si è già mostrata l'introduzione
  const doneLessons = () => CT.store.get('ct-academy-done', []);

  // ---------- Connessione ----------
  const send = (obj) => CT.send(obj);
  const act = (action) => send({ t: 'autoAct', action });

  function join(name, room) {
    session = { name, room, pid: session?.room === room ? session.pid : undefined };
    send({ t: 'autoJoin', ...session });
  }

  function onOpen() {
    if (session) send({ t: 'autoJoin', ...session });
  }

  function academy(name) {
    session = { name };
    send({ t: 'lessonList' });
  }

  function handle(msg) {
    if (msg.t === 'autoLessons') {
      lessonList = msg.lessons;
      M = null;
      CT.hideLobby();
      $('#auto').classList.remove('hidden');
      return renderAcademy();
    }
    if (msg.t === 'autoJoined') {
      session = { ...session, pid: msg.pid, room: msg.room };
      CT.store.set('ct-auto-session', session);
      CT.hideLobby();
      $('#auto').classList.remove('hidden');
    } else if (msg.t === 'autoState') {
      const wasMyDecision = myDecision();
      const prev = G();
      M = msg;
      if (msg.game) CT.noteArtists(msg.game);
      if (!myDecision() || (wasMyDecision && wasMyDecision.type !== myDecision()?.type)) resetDecisionUi();
      if (M.lesson?.done && !doneLessons().includes(M.lesson.id)) CT.store.set('ct-academy-done', [...doneLessons(), M.lesson.id]);
      if (prev && G()) FX.capture();
      render();
      if (prev && G()) animate(prev, G());
      if (M.lesson && introShown !== M.room) {
        introShown = M.room;
        CT.openModal(`<h2>Lezione ${M.lesson.n}: ${esc(M.lesson.title)}</h2><p>${esc(M.lesson.intro)}</p>
          <p><b>Obiettivo:</b> ${esc(M.lesson.goal)}</p><div class="row"><span class="grow"></span><button class="primary" data-close>Comincia</button></div>`);
      }
    } else if (msg.t === 'autoLeft') {
      CT.closeModal();
      const wasLesson = !!M?.lesson;
      M = null;
      CT.store.del('ct-auto-session');
      if (wasLesson) { send({ t: 'lessonList' }); return; }
      session = null;
      $('#auto').classList.add('hidden');
      CT.showLobby();
    } else if (msg.t === 'error') {
      toast(msg.msg, 5000);
      flow = null;
      render();
    }
  }

  // ---------- Animazioni (vista Arena) ----------
  function animate(prev, g) {
    const zoneOf = (key) => {
      const id = Number(key.slice(1));
      for (const p of g.players) {
        for (const z of ['graveyard', 'exile', 'hand', 'command', 'battlefield']) if ((p[z] || []).some((o) => o.cardId === id)) return z;
      }
      return g.stack.some((o) => o.cardId === id && !o.isAbility) ? 'stack' : null;
    };
    FX.play({ where: zoneOf });
    if (g.active !== prev.active && g.active === M.me && !g.winner) FX.banner('Il tuo turno');
    const seen = new Set(prev.stack.map((o) => o.id));
    for (const o of g.stack) if (!seen.has(o.id) && !o.isAbility) FX.spotlight(o.img, '#mg-stack');
  }

  // ---------- Utilità ----------
  const G = () => M?.game;
  const me = () => G()?.players.find((p) => p.id === M.me);
  const playerName = (pid) => G()?.players.find((p) => p.id === pid)?.name || M?.lobby.players.find((p) => p.id === pid)?.name || pid;
  const myDecision = () => (G()?.decision && G().decision.player === M.me ? G().decision : null);
  const myPriority = () => G() && G().priority === M.me && !G().decision;
  const allObjects = () => {
    const g = G();
    if (!g) return [];
    return [...g.players.flatMap((p) => [...(p.hand || []), ...p.battlefield, ...p.graveyard, ...p.exile, ...p.command]), ...g.stack];
  };
  const findObject = (id) => allObjects().find((o) => o.id === id);
  const targetLabel = (t) => (t.player ? playerName(t.player) : findObject(t.object)?.name || 'oggetto');
  const keyOf = (t) => (t.player ? `p:${t.player}` : `o:${t.object}`);
  const mana = (cost) => esc(cost || '').replace(/\{([^}]+)\}/g, (_, s) => `<img class="ms" src="https://svgs.scryfall.io/card-symbols/${s.replace(/\//g, '')}.svg" alt="{${s}}">`);

  function resetDecisionUi() {
    attack = null;
    block = null;
    picks = [];
    scryBottom = new Set();
  }

  // Elementi da evidenziare come scelte valide nel passo corrente
  function highlightKeys() {
    const keys = new Set();
    if (flow) {
      const step = flow.steps[flow.i];
      if (step?.kind === 'target') step.options.forEach((t) => keys.add(keyOf(t)));
      if (step?.kind === 'sacrifice') step.options.forEach((id) => keys.add(`o:${id}`));
      if (step?.kind === 'discard') (me()?.hand || []).filter((o) => o.id !== step.exclude).forEach((o) => keys.add(`o:${o.id}`));
      return keys;
    }
    const d = myDecision();
    if (d?.type === 'chooseTarget') d.options.forEach((t) => keys.add(keyOf(t)));
    if (d?.type === 'chooseSacrifice') d.options.forEach((id) => keys.add(`o:${id}`));
    if (d?.type === 'discard' || d?.type === 'putBack') (me()?.hand || []).forEach((o) => keys.add(`o:${o.id}`));
    if (d?.type === 'declareAttackers') {
      me().battlefield.filter((o) => o.power != null && !o.tapped && !o.sick && !o.keywords.includes('Defender')).forEach((o) => keys.add(`o:${o.id}`));
    }
    if (d?.type === 'declareBlockers') {
      me().battlefield.filter((o) => o.power != null && !o.tapped).forEach((o) => keys.add(`o:${o.id}`));
      G().combat?.attackers.filter((a) => a.defender === M.me).forEach((a) => keys.add(`o:${a.id}`));
    }
    return keys;
  }

  // ---------- Accademia ----------
  function renderAcademy() {
    const done = doneLessons();
    $('#auto').innerHTML = `<div class="auto-lobby academy">
      <h2>Accademia</h2>
      <p class="muted">Otto lezioni brevi contro il Maestro, un avversario che gioca mosse preparate. Ogni lezione è una partita vera:
      le regole le applica il motore, tu segui l'obiettivo e i suggerimenti nel riquadro a destra.</p>
      <ol class="lessons">${lessonList.map((l) => `<li><button class="lesson ${done.includes(l.id) ? 'done' : ''}" data-lesson="${l.id}">
        <b>${l.n}. ${esc(l.title)}</b>${done.includes(l.id) ? ' <span class="ok">✓ superata</span>' : ''}<small>${esc(l.goal)}</small></button></li>`).join('')}</ol>
      <div class="row"><span class="grow"></span><button data-auto="menu">Torna al menu</button></div>
    </div>`;
  }

  // ---------- Rendering ----------
  function render() {
    const root = $('#auto');
    if (!M) { root.innerHTML = ''; return; }
    root.innerHTML = G() ? (CT.compact() ? compactHtml() : gameHtml()) : lobbyHtml();
    if (G()) $('#auto-log')?.scrollTo(0, 1e9);
  }

  function lobbyHtml() {
    const L = M.lobby;
    const isHost = L.host === M.me;
    const mine = L.players.find((p) => p.id === M.me);
    const deckOptions = (M.decks || []).map((d) => `<option value="${d.id}" ${d.ok ? '' : 'disabled'} ${mine?.deck === d.id ? 'selected' : ''}>
      ${esc(d.name)} — ${esc(d.commander)}${d.ok ? '' : ` (il motore non conosce ancora ${d.unknownCount} carte)`}</option>`).join('');
    return `<div class="auto-lobby">
      <h2>Tavolo «${esc(M.room)}» · regole automatiche</h2>
      <p class="muted">Il motore applica le regole: fasi, priorità, Pila, combattimento, danni da comandante. Si gioca con i mazzi iniziali
      o con i mazzi salvati le cui carte sono tutte programmate. Gli altri giocatori entrano con lo stesso nome del tavolo,
      oppure aggiungi giocatori computer per riempire i posti (da 2 a 4 in tutto).</p>
      ${isHost && L.players.filter((p) => !p.bot).length < 2 ? `<div class="auto-invite"><span>Vuoi giocare con gli amici? Mandagli il link di questo tavolo.</span>
        <button class="primary" data-auto="invite">📨 Invita amici</button></div>` : ''}
      <ul class="auto-seats">${L.players.map((p) => `<li>${p.id === L.host ? '★ ' : ''}${p.bot ? '🤖 ' : ''}<b>${esc(p.name)}</b>
        <span class="muted">${p.deckName ? esc(p.deckName) : 'deve scegliere un mazzo'}${p.connected ? '' : ' · disconnesso'}</span>
        ${p.bot && isHost ? `<span class="grow"></span><button class="small" data-remove-bot="${p.id}">Togli</button>` : ''}</li>`).join('')}</ul>
      ${isHost && L.players.length < 4 ? `<div class="row"><select data-auto="bot-deck"><option value="">Mazzo del computer: a sorpresa</option>
        ${(M.decks || []).filter((d) => d.id.startsWith('starter-')).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>
        <button data-auto="add-bot">🤖 Aggiungi giocatore computer</button></div>` : ''}
      <label>Il tuo mazzo <select data-auto="deck"><option value="">— scegli —</option>${deckOptions}</select></label>
      <div class="row">
        ${isHost ? '<button class="primary" data-auto="start">Avvia la partita</button>' : '<span class="muted">La partita la avvia chi ha creato il tavolo (★).</span>'}
        <button data-auto="invite" class="${isHost ? '' : 'primary'}">📨 Invita amici</button>
        <span class="grow"></span><button data-auto="leave">Esci</button>
      </div>
      ${logHtml()}
    </div>`;
  }

  function cardHtml(o, zone, keys) {
    const classes = ['acard'];
    if (o.tapped) classes.push('tapped');
    if (keys.has(`o:${o.id}`)) classes.push('hl');
    if (attack?.pairs.has(o.id) || block?.selected === o.id || block?.pairs.some((p) => p.blocker === o.id)) classes.push('sel');
    if (picks.includes(o.id)) classes.push('sel');
    if (G().combat?.attackers.some((a) => a.id === o.id)) classes.push('attacking');
    // aiuto per i neofiti: cosa si può fare adesso e, se no, perché
    let why = '';
    if (myPriority() && !flow) {
      const ab = (o.abilities || []).filter((a) => a.playable);
      const ok = o.playable?.ok || ab.some((a) => a.playable.ok);
      if (o.playable || ab.length) classes.push(ok ? 'can' : 'cant');
      if (!ok) why = o.playable?.message || ab[0]?.playable.message || '';
    }
    const img = o.img ? `style="background-image:url('${esc(o.img)}')"` : '';
    if (!o.img) classes.push('textcard');
    const pt = o.power != null ? `<span class="apt ${o.damage ? 'hurt' : ''}">${o.power}/${o.toughness - (o.damage || 0)}</span>` : '';
    const counters = o.counters?.['+1/+1'] ? `<span class="acnt">+${o.counters['+1/+1']}</span>` : '';
    const sick = o.sick ? '<span class="asick" title="Debolezza da evocazione">💤</span>' : '';
    const text = o.img ? '' : `<span class="atname">${esc(o.name)}</span>`;
    return `<div class="${classes.join(' ')}" ${img} data-oid="${o.id}" data-zone="${zone}" title="${esc(why ? `${o.name}: ${why}` : o.name)}">${text}${pt}${counters}${sick}</div>`;
  }

  function panelHtml(p, keys) {
    const g = G();
    const commanders = new Map(allObjects().filter((o) => o.isCommander).map((o) => [o.cardId, o.name]));
    const cmd = p.commanderDamage.filter((c) => c.amount).map((c) => `<span class="chip ${c.amount >= 21 ? 'lethal' : ''}" title="Danni da comandante">⚔ ${esc((commanders.get(c.cardId) || '?').split(',')[0])}: ${c.amount}</span>`).join('');
    const pool = Object.entries(p.pool).filter(([, n]) => n).map(([c, n]) => `${mana(`{${c}}`)}×${n}`).join(' ');
    const rows = [
      p.battlefield.filter((o) => o.types.includes('Creature')),
      p.battlefield.filter((o) => !o.types.includes('Creature') && !o.types.includes('Land')),
      p.battlefield.filter((o) => o.types.includes('Land')),
    ];
    const classes = ['apanel'];
    if (g.active === p.id) classes.push('active');
    if (g.priority === p.id || g.decision?.player === p.id) classes.push('waiting');
    if (keys.has(`p:${p.id}`)) classes.push('hl');
    if (p.lost) classes.push('lost');
    if (attack && attack.defender === p.id) classes.push('defender');
    return `<div class="${classes.join(' ')}" data-player="${p.id}">
      <div class="ahead">
        <b class="aname">${esc(p.name)}${p.lost ? ' · eliminato' : ''}</b>
        <span class="alife" title="Punti vita">❤ ${p.life}</span>
        ${p.poison ? `<span class="chip" title="Segnalini veleno">☠ ${p.poison}</span>` : ''}
        ${cmd}
        <span class="muted">✋ ${p.handCount} · 📚 ${p.libraryCount}</span>
        ${pool ? `<span class="apool">${pool}</span>` : ''}
        <span class="grow"></span>
        <button class="small" data-pile="graveyard" data-of="${p.id}">Cimitero ${p.graveyard.length}</button>
        ${p.exile.length ? `<button class="small" data-pile="exile" data-of="${p.id}">Esilio ${p.exile.length}</button>` : ''}
      </div>
      <div class="abody">
        <div class="arows">${rows.map((r) => `<div class="arow">${r.map((o) => cardHtml(o, 'battlefield', keys)).join('')}</div>`).join('')}</div>
        <div class="acommand">${p.command.map((o) => cardHtml(o, 'command', keys)).join('')}</div>
      </div>
    </div>`;
  }

  function stepTrack() {
    const g = G();
    return STEPS.map(([id, label]) => `<span class="astep ${g.step === id || (id === 'combatDamage' && g.step === 'firstStrikeDamage') ? 'on' : ''}">${label}</span>`).join('');
  }

  function logHtml() {
    return `<div id="auto-log" class="auto-log">${(M.log || []).map((e) => `<div>${esc(e.text)}</div>`).join('')}</div>`;
  }

  function stackHtml() {
    const s = G().stack;
    if (!s.length) return '<div class="muted">La Pila è vuota.</div>';
    return [...s].reverse().map((o, i) => `<div class="astack-item ${i === 0 ? 'top' : ''}" data-oid="${o.id}" data-zone="stack">
      <b>${esc(o.name)}</b>${o.isAbility ? ' <span class="muted">(abilità)</span>' : ''}
      <span class="muted">di ${esc(playerName(o.controller))}${o.targets?.length ? ` → ${o.targets.map((t) => esc(targetLabel(t))).join(', ')}` : ''}</span></div>`).join('');
  }

  function gameHtml() {
    const g = G();
    const keys = highlightKeys();
    const mine = me();
    const i = g.players.findIndex((p) => p.id === M.me);
    const others = [...g.players.slice(i + 1), ...g.players.slice(0, i)];
    const status = g.winner ? `${esc(playerName(g.winner))} vince la partita!`
      : g.decision ? `${g.decision.player === M.me ? 'Tocca a te' : `In attesa di ${esc(playerName(g.decision.player))}`}: ${DECISION_NAMES[g.decision.type] || g.decision.type}`
        : g.priority === M.me ? 'Hai la priorità' : `Priorità a ${esc(playerName(g.priority))}`;
    return `<header class="auto-top">
        <b>Turno ${g.turn}</b><span class="muted">di ${esc(playerName(g.active))}</span>
        <div class="asteps">${stepTrack()}</div>
        <span class="astatus ${g.priority === M.me || myDecision() ? 'mine' : ''}">${status}</span>
        <button class="primary ${myPriority() && g.stack.length ? 'urgent' : ''}" data-auto="pass" ${myPriority() ? '' : 'disabled'} title="Passa la priorità (Spazio)">Passa</button>
        <button data-auto="arena" title="Torna alla vista Arena">Vista Arena</button>
        <button data-auto="leave">Esci</button>
      </header>
      <div class="auto-main">
        <div class="auto-table">
          <div class="auto-opps">${others.map((p) => panelHtml(p, keys)).join('')}</div>
          ${panelHtml(mine, keys)}
          <div class="auto-hand">${(mine.hand || []).map((o) => cardHtml(o, 'hand', keys)).join('') || '<span class="muted">Mano vuota</span>'}</div>
        </div>
        <aside class="auto-side">
          <div id="auto-preview" class="auto-preview"><span class="muted">Passa sopra una carta per vederla</span></div>
          ${M.lesson ? `<div class="auto-lesson"><b>Lezione ${M.lesson.n}: ${esc(M.lesson.title)}</b>
            <div class="muted">${esc(M.lesson.goal)}</div><div class="lesson-hint">💡 ${esc(M.lesson.hint)}</div></div>` : ''}
          <div class="auto-prompt">${promptHtml()}</div>
          ${M.lesson ? '' : `<label class="autopass" title="Come in MTG Arena: se in quel momento non hai carte da giocare né abilità da attivare, la priorità passa da sola">
          <input type="checkbox" data-autopass ${M.autoPass ? 'checked' : ''}> Passa da solo quando non posso fare niente</label>`}
          <h4>Pila</h4><div class="auto-stack">${stackHtml()}</div>
          <h4>Registro</h4>${logHtml()}
        </aside>
      </div>
      ${overlaysHtml()}`;
  }

  // Fine lezione o fine partita
  function overlaysHtml() {
    const g = G();
    return `${M.lesson?.done || M.lesson?.failed ? `<div class="auto-over"><div>
        <h2>${M.lesson.done ? 'Lezione superata!' : 'Riproviamo'}</h2><p>${esc(M.lesson.done ? M.lesson.goal : M.lesson.hint)}</p>
        <div class="row" style="justify-content:center">
          ${M.lesson.done && M.lesson.next ? `<button class="primary" data-lesson="${M.lesson.next}">Lezione successiva</button>` : ''}
          ${M.lesson.failed ? `<button class="primary" data-lesson="${M.lesson.id}">Riprova</button>` : ''}
          <button data-auto="leave">Torna all'Accademia</button></div></div></div>` : ''}
      ${g.winner && !M.lesson ? `<div class="auto-over"><div><h2>${esc(playerName(g.winner))} vince la partita!</h2><button class="primary" data-auto="leave">Torna al menu</button></div></div>` : ''}`;
  }

  // ---------- Schermata compatta per i telefoni ----------
  // Carta piccola con la sola illustrazione, il nome sopra e forza/costituzione in basso
  function miniHtml(o, zone, keys, count = 1) {
    const classes = ['mc'];
    if (zone === 'command') classes.push('cmdzone');
    if (o.tapped) classes.push('tapped');
    if (keys.has(`o:${o.id}`)) classes.push('hl');
    if (attack?.pairs.has(o.id) || block?.selected === o.id || block?.pairs.some((p) => p.blocker === o.id) || picks.includes(o.id)) classes.push('sel');
    if (G().combat?.attackers.some((a) => a.id === o.id)) classes.push('attacking');
    if (myPriority() && !flow) {
      const ab = (o.abilities || []).filter((a) => a.playable);
      if (o.playable || ab.length) classes.push(o.playable?.ok || ab.some((a) => a.playable.ok) ? 'can' : 'cant');
    }
    const art = o.art || o.img;
    const pt = o.power != null ? `<span class="mc-pt ${o.damage ? 'hurt' : ''}">${o.power}/${o.toughness - (o.damage || 0)}</span>` : '';
    const plus = o.counters?.['+1/+1'] ? `<span class="mc-cnt">+${o.counters['+1/+1']}</span>` : '';
    const sick = o.sick ? '<span class="mc-sick">💤</span>' : '';
    const n = count > 1 ? `<span class="mc-n">×${count}</span>` : '';
    return `<div class="${classes.join(' ')}" data-oid="${o.id}" data-zone="${zone}" title="${esc(o.name)}"
      data-fx="c${o.cardId}" data-fx-dmg="${o.damage || 0}" data-fx-token="${o.isToken ? 1 : 0}">
      <span class="mc-art" ${art ? `style="background-image:url('${esc(art)}')"` : ''}></span>
      <span class="mc-name">${esc(o.name)}</span>${pt}${plus}${sick}${n}</div>`;
  }

  // Terre uguali nello stesso stato in un'unica carta con il numero: occupano molto meno spazio
  function landGroups(lands, keys) {
    const groups = new Map();
    for (const o of lands) {
      const special = keys.has(`o:${o.id}`) || picks.includes(o.id) || attack?.pairs.has(o.id);
      const k = special ? `#${o.id}` : `${o.name}|${o.tapped}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    return [...groups.values()];
  }

  function fieldHtml(p, keys, mirrored) {
    const lands = p.battlefield.filter((o) => o.types.includes('Land') && !o.types.includes('Creature'));
    const others = p.battlefield.filter((o) => !lands.includes(o));
    const creatures = others.filter((o) => o.types.includes('Creature'));
    const rest = others.filter((o) => !o.types.includes('Creature'));
    const main = `<div class="mg-row">${[...creatures, ...rest].map((o) => miniHtml(o, 'battlefield', keys)).join('')}
      ${p.command.map((o) => miniHtml(o, 'command', keys)).join('')}</div>`;
    const landRow = `<div class="mg-row mg-lands">${landGroups(lands, keys).map((gr) => miniHtml(gr.find((o) => !o.tapped) || gr[0], 'battlefield', keys, gr.length)).join('')}</div>`;
    return mirrored ? landRow + main : main + landRow;
  }

  function pilesHtml(p) {
    return `<button class="small" data-pile="graveyard" data-of="${p.id}" title="Cimitero">🪦 ${p.graveyard.length}</button>
      ${p.exile.length ? `<button class="small" data-pile="exile" data-of="${p.id}" title="Esilio">🌀 ${p.exile.length}</button>` : ''}`;
  }

  function tabHtml(p, keys) {
    const g = G();
    const classes = ['mg-tab'];
    if (p.id === focusId) classes.push('on');
    if (g.active === p.id) classes.push('active');
    if (g.priority === p.id || g.decision?.player === p.id) classes.push('waiting');
    if (keys.has(`p:${p.id}`) || p.battlefield.some((o) => keys.has(`o:${o.id}`))) classes.push('hl');
    if (attack?.defender === p.id) classes.push('defender');
    if (g.combat?.attackers.some((a) => a.controller === p.id && a.defender === M.me)) classes.push('threat');
    if (p.lost) classes.push('lost');
    const cmd = Math.max(0, ...p.commanderDamage.map((c) => c.amount));
    return `<button class="${classes.join(' ')}" data-focus="${p.id}" data-player="${p.id}">
      <b>${esc(p.name)}</b><span class="mg-tlife" data-fx-life="${p.id}" data-v="${p.life}">❤ ${p.life}</span><span class="muted">✋${p.handCount}</span>
      ${p.poison ? `<span>☠${p.poison}</span>` : ''}${cmd ? `<span class="${cmd >= 21 ? 'lethal' : ''}">⚔${cmd}</span>` : ''}</button>`;
  }

  function compactHtml() {
    const g = G();
    const keys = highlightKeys();
    const mine = me();
    const i = g.players.findIndex((p) => p.id === M.me);
    const others = [...g.players.slice(i + 1), ...g.players.slice(0, i)];
    // l'avversario in grande segue chi è di turno, finché non ne scegli un altro
    if (g.active !== lastActive) {
      lastActive = g.active;
      if (g.active !== M.me) focusId = g.active;
    }
    if (!others.some((p) => p.id === focusId)) focusId = (others.find((p) => !p.lost) || others[0])?.id;
    const opp = others.find((p) => p.id === focusId);
    if (raised && !(mine.hand || []).some((o) => o.id === raised)) raised = null;
    const step = STEPS.find(([id]) => g.step === id || (id === 'combatDamage' && g.step === 'firstStrikeDamage'))?.[1] || '';
    const status = g.winner ? `${esc(playerName(g.winner))} vince!`
      : g.decision ? (g.decision.player === M.me ? `Tocca a te: ${DECISION_NAMES[g.decision.type] || g.decision.type}` : `Attendi ${esc(playerName(g.decision.player))}`)
        : g.priority === M.me ? 'Hai la priorità' : `Priorità a ${esc(playerName(g.priority))}`;
    const pool = Object.entries(mine.pool).filter(([, n]) => n).map(([c, n]) => `${mana(`{${c}}`)}${n}`).join(' ');
    const hand = mine.hand || [];
    const top = g.stack[g.stack.length - 1];
    const pv = previewId != null && findObject(previewId);
    return `<div class="mg">
      <nav class="mg-tabs">${others.map((p) => tabHtml(p, keys)).join('')}</nav>
      <section class="mg-field mg-opp ${opp && keys.has(`p:${opp.id}`) ? 'hl' : ''}" data-player="${opp?.id || ''}" data-fx-area="f${opp?.id || ''}">
        ${opp ? `${fieldHtml(opp, keys, true)}<div class="mg-piles">${pilesHtml(opp)}</div>` : ''}
      </section>
      <div class="mg-mid">
        <span class="mg-life ${keys.has(`p:${M.me}`) ? 'hl' : ''} ${g.active === M.me ? 'active' : ''}" data-player="${M.me}" data-fx-life="${M.me}" data-v="${mine.life}">❤ ${mine.life}</span>
        ${mine.poison ? `<span class="chip">☠ ${mine.poison}</span>` : ''}
        <span class="muted">✋${hand.length} · 📚${mine.libraryCount}</span>${pool ? `<span class="apool">${pool}</span>` : ''}
        <span class="mg-step">T${g.turn} · ${esc(step)}</span>
        <span class="mg-status ${g.priority === M.me || myDecision() ? 'mine' : ''}">${status}</span>
        ${top ? `<span class="mg-stack" id="mg-stack" data-oid="${top.id}" data-zone="stack">Pila: ${esc(top.name)}${g.stack.length > 1 ? ` +${g.stack.length - 1}` : ''}</span>` : ''}
        <span class="grow"></span>${pilesHtml(mine)}
      </div>
      <section class="mg-field mg-me" data-fx-area="f${M.me}">${fieldHtml(mine, keys, false)}</section>
      <div class="mg-hand" style="--n:${hand.length}" data-fx-area="h${M.me}">${hand.map((o, k) => {
        const c = ['mg-hcard'];
        if (keys.has(`o:${o.id}`)) c.push('hl');
        if (picks.includes(o.id)) c.push('sel');
        if (o.id === raised) c.push('raised');
        if (myPriority() && !flow && o.playable) c.push(o.playable.ok ? 'can' : 'cant');
        return `<div class="${c.join(' ')}" style="--i:${k};${o.img ? `background-image:url('${esc(o.img)}')` : ''}" data-oid="${o.id}" data-zone="hand" data-fx="c${o.cardId}" title="${esc(o.name)}">${o.img ? '' : `<span>${esc(o.name)}</span>`}</div>`;
      }).join('') || '<span class="muted">Mano vuota</span>'}</div>
      <aside class="mg-side">
        <div id="auto-preview" class="mg-preview">${pv?.img ? `<img src="${esc(pv.img)}" alt="${esc(pv.name)}">${CT.credit(pv.img)}` : `<span class="muted">${CT.hover() ? 'Passa sopra una carta per vederla' : 'Tocca una carta per vederla'}</span>`}</div>
        ${M.lesson ? `<div class="auto-lesson"><b>${esc(M.lesson.goal)}</b><div class="lesson-hint">💡 ${esc(M.lesson.hint)}</div></div>` : ''}
        <div class="auto-prompt">${promptHtml()}</div>
        <div class="mg-actions">
          <button class="primary mg-pass ${myPriority() && g.stack.length ? 'urgent' : ''}" data-auto="pass" ${myPriority() ? '' : 'disabled'}>Passa</button>
          <button data-auto="log" title="Registro e Pila">📜</button>
          <button data-auto="classic" title="Vista classica">▦</button>
          <button data-auto="leave" title="Esci">✕</button>
        </div>
        ${M.lesson ? '' : `<label class="autopass" title="Come in MTG Arena: se in quel momento non hai carte da giocare né abilità da attivare, la priorità passa da sola">
          <input type="checkbox" data-autopass ${M.autoPass ? 'checked' : ''}> Passa da solo quando non posso fare niente</label>`}
      </aside>
      ${overlaysHtml()}
    </div>`;
  }

  // Istruzioni e pulsanti per il passo corrente
  function promptHtml() {
    const g = G();
    if (g.winner) return '';
    if (flow) {
      const step = flow.steps[flow.i];
      const cancel = '<button data-auto="cancel">Annulla</button>';
      if (step.kind === 'mode') {
        return `<b>${esc(flow.title)}</b><p>Scegli una modalità:</p>${step.modes.map((m) => `<button data-mode="${m.index}">${esc(m.name)}</button>`).join(' ')} ${cancel}`;
      }
      if (step.kind === 'color') {
        return `<b>${esc(flow.title)}</b><p>Che colore di mana?</p>${step.colors.map((c) => `<button data-color="${c}">${mana(`{${c}}`)}</button>`).join(' ')} ${cancel}`;
      }
      if (step.kind === 'target') {
        return `<b>${esc(flow.title)}</b><p>Scegli il bersaglio${flow.steps.filter((s) => s.kind === 'target').length > 1 ? ` n. ${step.index + 1}` : ''} (evidenziato sul tavolo):</p>
          <div class="aopts">${step.options.map((t) => `<button data-target='${esc(JSON.stringify(t))}'>${esc(targetLabel(t))}</button>`).join('')}</div>${cancel}`;
      }
      if (step.kind === 'sacrifice') {
        return `<b>${esc(flow.title)}</b><p>Cosa sacrifichi per pagare il costo?</p>
          <div class="aopts">${step.options.map((id) => `<button data-sac="${id}">${esc(findObject(id)?.name || id)}</button>`).join('')}</div>${cancel}`;
      }
      if (step.kind === 'discard') {
        return `<b>${esc(flow.title)}</b><p>Scegli ${step.count} carta da scartare (clicca nella mano).</p>${cancel}`;
      }
    }
    const d = myDecision();
    if (d) return decisionPrompt(d);
    if (g.decision) return `<p class="muted">In attesa che ${esc(playerName(g.decision.player))} finisca di ${DECISION_NAMES[g.decision.type] || 'decidere'}…</p>`;
    const top = g.stack[g.stack.length - 1];
    if (top && myPriority()) {
      return top.controller === M.me
        ? `<p><b>Hai lanciato ${esc(top.name)}.</b> Premi <b>Passa</b> per farla risolvere, oppure aggiungi un'altra magia o abilità.</p>`
        : `<p><b>${esc(playerName(top.controller))} ha lanciato ${esc(top.name)}.</b> Puoi rispondere con un istantaneo o un'abilità, oppure premi <b>Passa</b> per lasciarla risolvere.</p>`;
    }
    if (top && !g.decision) return `<p class="muted">In attesa che ${esc(playerName(g.priority))} risponda a ${esc(top.name)}…</p>`;
    if (myPriority() && CT.compact()) return '<p><b>Hai la priorità.</b> Tocca una carta per giocarla o un tuo permanente per le abilità, oppure Passa.</p>';
    if (myPriority()) {
      return `<p><b>Hai la priorità.</b> Clicca una carta in mano per giocarla o lanciarla, un tuo permanente per usarne le abilità,
        oppure passa (Spazio). Il mana si paga in automatico con le tue terre.</p>`;
    }
    return `<p class="muted">Priorità a ${esc(playerName(g.priority))}.</p>`;
  }

  function decisionPrompt(d) {
    const g = G();
    switch (d.type) {
      case 'declareAttackers': {
        attack ||= { defender: g.players.find((p) => p.id !== M.me && !p.lost)?.id, pairs: new Map() };
        const opps = g.players.filter((p) => p.id !== M.me && !p.lost);
        return `<b>Dichiara gli attaccanti</b>
          <p>Scegli chi attaccare, poi clicca le tue creature. Clicca di nuovo per toglierle.</p>
          <div class="aopts">${opps.map((p) => `<button data-defender="${p.id}" class="${attack.defender === p.id ? 'on' : ''}">Attacca ${esc(p.name)}</button>`).join('')}</div>
          <ul class="apairs">${[...attack.pairs].map(([id, def]) => `<li>${esc(findObject(id)?.name)} → ${esc(playerName(def))}</li>`).join('')}</ul>
          <button class="primary" data-auto="confirm-attack">${attack.pairs.size ? 'Conferma attacco' : 'Nessun attacco'}</button>`;
      }
      case 'declareBlockers': {
        block ||= { selected: null, pairs: [] };
        return `<b>Dichiara i bloccanti</b>
          <p>Clicca una tua creatura, poi la creatura attaccante che deve bloccare.</p>
          <ul class="apairs">${block.pairs.map((p, i) => `<li>${esc(findObject(p.blocker)?.name)} blocca ${esc(findObject(p.attacker)?.name)} <button class="small" data-unblock="${i}">✕</button></li>`).join('')}</ul>
          <button class="primary" data-auto="confirm-block">${block.pairs.length ? 'Conferma blocchi' : 'Nessun blocco'}</button>`;
      }
      case 'chooseTarget':
        return `<b>${esc(d.source || 'Abilità innescata')}</b><p>Scegli un bersaglio:</p>
          <div class="aopts">${d.options.map((t) => `<button data-dtarget='${esc(JSON.stringify(t))}'>${esc(targetLabel(t))}</button>`).join('')}</div>
          ${d.optional ? '<button data-auto="no-target">Nessun bersaglio</button>' : ''}`;
      case 'chooseSacrifice':
        return `<b>Scegli cosa sacrificare</b><div class="aopts">${d.options.map((id) => `<button data-dsac="${id}">${esc(findObject(id)?.name)}</button>`).join('')}</div>`;
      case 'discard':
      case 'putBack':
        return `<b>${d.type === 'discard' ? 'Scarta' : 'Rimetti in cima al grimorio'} ${d.count} carte</b>
          <p>Clicca le carte nella tua mano${d.type === 'putBack' ? ' (la prima scelta finisce in cima)' : ''}. Scelte: ${picks.length}/${d.count}</p>
          <button class="primary" data-auto="confirm-picks" ${picks.length === d.count ? '' : 'disabled'}>Conferma</button>`;
      case 'confirm':
        return `<b>${esc(d.prompt)}</b><div class="row"><button class="primary" data-yes="1">Sì</button><button data-yes="0">No</button></div>`;
      case 'search':
      case 'chooseCards':
        return `<b>${d.type === 'search' ? `Cerca nel grimorio (fino a ${d.max})` : `Scegli ${d.count} carte`}</b>
          <div class="acards">${d.cards.map((o) => `<div class="apick ${picks.includes(o.id) ? 'on' : ''}" data-pick="${o.id}">${o.img ? `<img src="${esc(o.img)}" alt="${esc(o.name)}">` : esc(o.name)}</div>`).join('') || '<span class="muted">Nessuna carta valida</span>'}</div>
          <button class="primary" data-auto="confirm-cards" ${d.type === 'chooseCards' && picks.length !== d.count ? 'disabled' : ''}>Conferma</button>`;
      case 'scry':
        return `<b>Profetizza ${d.cards.length}</b><p>Clicca le carte da mettere in fondo al grimorio.</p>
          <div class="acards">${d.cards.map((o) => `<div class="apick ${scryBottom.has(o.id) ? 'bottom' : ''}" data-scry="${o.id}">${o.img ? `<img src="${esc(o.img)}" alt="">` : esc(o.name)}<span>${scryBottom.has(o.id) ? 'in fondo' : 'in cima'}</span></div>`).join('')}</div>
          <button class="primary" data-auto="confirm-scry">Conferma</button>`;
      default:
        return `<p>Decisione: ${esc(d.type)}</p>`;
    }
  }

  // ---------- Costruzione delle azioni ----------
  function startFlow(action, steps, title) {
    flow = { action, steps, i: 0, title };
    advanceFlow();
  }

  function advanceFlow() {
    while (flow && flow.i < flow.steps.length) {
      const step = flow.steps[flow.i];
      if ((step.kind === 'target' || step.kind === 'sacrifice') && !step.options.length) {
        toast(step.kind === 'target' ? 'Non ci sono bersagli validi' : 'Non hai nulla da sacrificare per pagare il costo');
        flow = null;
        break;
      }
      if (step.kind === 'color' && step.colors.length === 1) { flow.action.color = step.colors[0]; flow.i++; continue; }
      break;
    }
    if (flow && flow.i >= flow.steps.length) {
      act(flow.action);
      flow = null;
    }
    render();
  }

  const targetSteps = (targets) => targets.map((options, index) => ({ kind: 'target', options, index }));

  function costSteps(info, excludeId) {
    const steps = [];
    if (info.sacrificeOptions) steps.push({ kind: 'sacrifice', options: info.sacrificeOptions });
    if (info.discard) steps.push({ kind: 'discard', count: info.discard, exclude: excludeId });
    return steps;
  }

  function castCard(o) {
    if (!myPriority()) return toast(G().decision ? 'Prima va presa la decisione in corso' : 'Non hai la priorità');
    const c = o.cast;
    if (!c) return toast('Questa carta non si può giocare adesso');
    if (c.playable && !c.playable.ok && c.playable.code !== 'NO_TARGETS') return toast(`Perché no? ${c.playable.message}`, 5000);
    if (c.land) return act({ type: 'playLand', object: o.id });
    const steps = c.modes ? [{ kind: 'mode', modes: c.modes }] : targetSteps(c.targets);
    startFlow({ type: 'cast', object: o.id, targets: [], autoPay: true }, [...steps, ...costSteps(c, o.id)], `Lanci ${o.name} (${c.cost})`);
  }

  function useAbility(o, ab) {
    if (ab.kind === 'mana') {
      const steps = [];
      if (ab.colors) steps.push({ kind: 'color', colors: ab.colors });
      startFlow({ type: 'activateMana', object: o.id }, [...steps, ...costSteps(ab)], `Mana da ${o.name}`);
    } else {
      startFlow({ type: 'activate', object: o.id, ability: ab.index, targets: [], autoPay: true },
        [...targetSteps(ab.targets), ...costSteps(ab)], `Abilità di ${o.name}`);
    }
  }

  function abilityMenu(o, x, y) {
    if (!myPriority()) return toast('Non hai la priorità');
    const abilities = o.abilities || [];
    if (!abilities.length) return toast(`${o.name} non ha abilità da attivare`);
    const label = (ab) => {
      const parts = [ab.tap ? '{T}' : '', ab.cost, ab.sacrifice ? 'sacrifica' : '', ab.discard ? 'scarta' : ''].filter(Boolean).join(', ');
      return ab.kind === 'mana' ? `Mana: ${ab.produce === 'commanderIdentity' || ab.produce === 'anyColor' ? 'un colore a scelta' : ab.produce}${parts ? ` (${parts})` : ''}` : `Attiva: ${parts || 'senza costo'}`;
    };
    CT.showMenu(x, y, o.name, abilities.map((ab) => {
      const no = ab.playable && !ab.playable.ok;
      return [no ? `${label(ab)} — non ora: ${ab.playable.message}` : label(ab), () => (no ? toast(`Perché no? ${ab.playable.message}`, 5000) : useAbility(o, ab))];
    }));
  }

  // ---------- Interazione ----------
  document.addEventListener('click', (e) => {
    if ((!M && !lessonList) || $('#auto').classList.contains('hidden')) return;
    const t = e.target;
    const btn = t.closest('button');
    const d = myDecision();
    const step = flow?.steps[flow.i];
    if (btn?.dataset.auto) return button(btn.dataset.auto);
    if (btn?.dataset.focus) {
      // una linguetta: bersaglio o difensore se serve, altrimenti mostra quel giocatore in grande
      const pid = btn.dataset.focus;
      const keys = highlightKeys();
      focusId = pid;
      if (keys.has(`p:${pid}`) || (attack && pid !== M.me)) return clickPlayer(pid);
      return render();
    }
    if (btn?.dataset.removeBot) return send({ t: 'autoRemoveBot', pid: btn.dataset.removeBot });
    if (btn?.dataset.lesson) { flow = null; resetDecisionUi(); return send({ t: 'lessonStart', id: btn.dataset.lesson, name: session?.name || 'Allievo' }); }
    if (btn?.dataset.mode && step?.kind === 'mode') {
      const m = step.modes[Number(btn.dataset.mode)];
      flow.action.mode = m.index;
      flow.steps.splice(flow.i + 1, 0, ...targetSteps(m.targets));
      flow.i++;
      return advanceFlow();
    }
    if (btn?.dataset.color && step?.kind === 'color') { flow.action.color = btn.dataset.color; flow.i++; return advanceFlow(); }
    if (btn?.dataset.target && step?.kind === 'target') return pickFlowTarget(JSON.parse(btn.dataset.target));
    if (btn?.dataset.sac && step?.kind === 'sacrifice') return pickFlowSacrifice(Number(btn.dataset.sac));
    if (btn?.dataset.dtarget && d?.type === 'chooseTarget') return act({ type: 'chooseTarget', target: JSON.parse(btn.dataset.dtarget) });
    if (btn?.dataset.dsac && d?.type === 'chooseSacrifice') return act({ type: 'chooseSacrifice', object: Number(btn.dataset.dsac) });
    if (btn?.dataset.defender && attack) { attack.defender = btn.dataset.defender; return render(); }
    if (btn?.dataset.unblock && block) { block.pairs.splice(Number(btn.dataset.unblock), 1); return render(); }
    if (btn?.dataset.yes && d?.type === 'confirm') return act({ type: 'confirm', yes: btn.dataset.yes === '1' });
    if (btn?.dataset.pile) return pileModal(btn.dataset.of, btn.dataset.pile);
    const pick = t.closest('[data-pick]');
    if (pick && d) {
      const id = Number(pick.dataset.pick);
      const max = d.type === 'search' ? d.max : d.count;
      if (picks.includes(id)) picks = picks.filter((x) => x !== id);
      else if (picks.length < max) picks.push(id);
      return render();
    }
    const scry = t.closest('[data-scry]');
    if (scry) {
      const id = Number(scry.dataset.scry);
      if (scryBottom.has(id)) scryBottom.delete(id); else scryBottom.add(id);
      return render();
    }
    const card = t.closest('[data-oid]');
    if (card) return clickObject(Number(card.dataset.oid), card.dataset.zone, e);
    const panel = t.closest('[data-player]');
    if (panel) return clickPlayer(panel.dataset.player);
  });

  function button(name) {
    const d = myDecision();
    switch (name) {
      case 'start': return send({ t: 'autoStart' });
      case 'add-bot': return send({ t: 'autoAddBot', deckId: $('[data-auto="bot-deck"]')?.value || undefined });
      case 'leave': if (!G() || G().winner || M.lesson || confirm('Lasciare il tavolo?')) send({ t: 'autoLeave' }); return undefined;
      case 'menu': lessonList = null; $('#auto').classList.add('hidden'); CT.showLobby(); return undefined;
      case 'pass': if (myPriority()) act({ type: 'pass' }); return undefined;
      case 'cancel': flow = null; return render();
      case 'classic': return CT.setView('classic');
      case 'invite': return CT.invite(M.room, 'auto');
      case 'arena': return CT.setView('arena');
      case 'log': return CT.openModal(`<h2>Pila</h2><div class="auto-stack">${stackHtml()}</div><h2>Registro</h2>${logHtml()}
        <div class="row"><span class="grow"></span><button data-close>Chiudi</button></div>`);
      case 'no-target': return act({ type: 'chooseTarget', target: null });
      case 'confirm-attack':
        return act({ type: 'declareAttackers', attackers: [...attack.pairs].map(([object, defender]) => ({ object, defender })) });
      case 'confirm-block': return act({ type: 'declareBlockers', blocks: block.pairs });
      case 'confirm-picks': return act({ type: d.type, objects: picks });
      case 'confirm-cards': return act(d.type === 'search' ? { type: 'search', objects: picks } : { type: 'chooseCards', objects: picks });
      case 'confirm-scry': {
        const ids = d.cards.map((o) => o.id);
        return act({ type: 'scry', top: ids.filter((id) => !scryBottom.has(id)), bottom: ids.filter((id) => scryBottom.has(id)) });
      }
      default: return undefined;
    }
  }

  function pickFlowTarget(target) {
    const step = flow.steps[flow.i];
    if (!step.options.some((t) => keyOf(t) === keyOf(target))) return toast('Non è un bersaglio valido per questa magia o abilità');
    flow.action.targets.push(target);
    flow.i++;
    return advanceFlow();
  }

  function pickFlowSacrifice(id) {
    const step = flow.steps[flow.i];
    if (!step.options.includes(id)) return toast('Non puoi sacrificare questo permanente per pagare il costo');
    flow.action.sacrifice = [id];
    flow.i++;
    return advanceFlow();
  }

  function clickPlayer(pid) {
    const step = flow?.steps[flow.i];
    if (step?.kind === 'target') return pickFlowTarget({ player: pid });
    const d = myDecision();
    if (d?.type === 'chooseTarget') {
      if (!d.options.some((t) => t.player === pid)) return toast('Non è un bersaglio valido');
      return act({ type: 'chooseTarget', target: { player: pid } });
    }
    if (attack && pid !== M.me) { attack.defender = pid; render(); }
    return undefined;
  }

  function clickObject(id, zone, e) {
    const o = findObject(id);
    if (!o) return;
    const step = flow?.steps[flow.i];
    if (step?.kind === 'target') return pickFlowTarget({ object: id });
    if (step?.kind === 'sacrifice') return pickFlowSacrifice(id);
    if (step?.kind === 'discard') {
      if (zone !== 'hand' || id === step.exclude) return toast('Scegli una carta dalla tua mano');
      flow.action.discard = [...(flow.action.discard || []), id];
      if (flow.action.discard.length >= step.count) flow.i++;
      return advanceFlow();
    }
    const d = myDecision();
    if (d) return clickDuringDecision(d, o, zone);
    // sul telefono il primo tocco solleva la carta dalla mano (per leggerla), il secondo la gioca
    if (zone === 'hand' && CT.compact() && !CT.hover() && raised !== id) {
      raised = id;
      previewId = id;
      return render();
    }
    raised = null;
    if (zone === 'hand' || (zone === 'command' && o.owner === M.me)) return castCard(o);
    if (zone === 'battlefield' && o.controller === M.me) return abilityMenu(o, e.clientX, e.clientY);
    return undefined;
  }

  function clickDuringDecision(d, o, zone) {
    if (d.type === 'chooseTarget') {
      if (!d.options.some((t) => t.object === o.id)) return toast('Non è un bersaglio valido');
      return act({ type: 'chooseTarget', target: { object: o.id } });
    }
    if (d.type === 'chooseSacrifice') {
      if (!d.options.includes(o.id)) return toast('Scegli una delle creature evidenziate');
      return act({ type: 'chooseSacrifice', object: o.id });
    }
    if ((d.type === 'discard' || d.type === 'putBack') && zone === 'hand') {
      if (picks.includes(o.id)) picks = picks.filter((x) => x !== o.id);
      else if (picks.length < d.count) picks.push(o.id);
      return render();
    }
    if (d.type === 'declareAttackers' && zone === 'battlefield' && o.controller === M.me) {
      if (attack.pairs.has(o.id)) attack.pairs.delete(o.id);
      else attack.pairs.set(o.id, attack.defender);
      return render();
    }
    if (d.type === 'declareBlockers' && zone === 'battlefield') {
      const attacking = G().combat?.attackers.find((a) => a.id === o.id && a.defender === M.me);
      if (o.controller === M.me && !attacking) { block.selected = block.selected === o.id ? null : o.id; return render(); }
      if (attacking) {
        if (!block.selected) return toast('Prima clicca una tua creatura che blocca');
        block.pairs = block.pairs.filter((p) => p.blocker !== block.selected);
        block.pairs.push({ blocker: block.selected, attacker: o.id });
        block.selected = null;
        return render();
      }
    }
    return toast(`Prima va completata la scelta: ${DECISION_NAMES[d.type] || d.type}`);
  }

  function pileModal(pid, zone) {
    const p = G().players.find((x) => x.id === pid);
    const cards = p[zone];
    CT.openModal(`<h2>${zone === 'graveyard' ? 'Cimitero' : 'Esilio'} di ${esc(p.name)} (${cards.length})</h2>
      <div class="acards">${cards.map((o) => `<div class="apick" data-oid="${o.id}" data-zone="${zone}">${o.img ? `<img src="${esc(o.img)}" alt="${esc(o.name)}">` : esc(o.name)}</div>`).join('') || '<span class="muted">Vuoto</span>'}</div>
      <div class="row"><span class="grow"></span><button data-close>Chiudi</button></div>`);
  }

  // Anteprima al passaggio del mouse
  document.addEventListener('mouseover', (e) => {
    if (!G()) return;
    const el = e.target.closest('[data-oid]');
    const pv = $('#auto-preview');
    if (!el || !pv) return;
    const o = findObject(Number(el.dataset.oid));
    if (!o) return;
    previewId = o.id;
    if (CT.compact()) {
      pv.innerHTML = o.img ? `<img src="${esc(o.img)}" alt="${esc(o.name)}">${CT.credit(o.img)}` : `<b>${esc(o.name)}</b>`;
      return;
    }
    const kws = (o.keywords || []).map((k) => KW[k] || k).join(', ');
    pv.innerHTML = o.img
      ? `<img src="${esc(o.img)}" alt="${esc(o.name)}">${CT.credit(o.img)}${kws ? `<div class="muted">${esc(kws)}</div>` : ''}`
      : `<b>${esc(o.name)}</b><div class="muted">${esc([...o.types, ...o.subtypes].join(' '))}</div>${o.power != null ? `<div>${o.power}/${o.toughness}</div>` : ''}<div class="muted">${esc(kws)}</div>`;
  });

  document.addEventListener('change', (e) => {
    if (e.target.dataset?.auto === 'deck' && e.target.value) send({ t: 'autoDeck', deckId: e.target.value });
    if (e.target.matches?.('[data-autopass]')) send({ t: 'autoPass', on: e.target.checked });
  });

  document.addEventListener('keydown', (e) => {
    if (!G() || $('#auto').classList.contains('hidden') || e.target.closest('input, textarea, select')) return;
    if (e.code === 'Space' && myPriority() && !flow) { e.preventDefault(); act({ type: 'pass' }); }
    if (e.key === 'Escape' && flow) { flow = null; render(); }
  });

  window.addEventListener('ct-compact', () => { if (G()) render(); });

  window.Auto = { join, onOpen, handle, academy, active: () => (!!M || !!lessonList) && !$('#auto').classList.contains('hidden') };
})();
