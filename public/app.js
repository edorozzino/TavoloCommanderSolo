// Client del tavolo Commander: rendering, drag & drop, menu e finestre.
(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage non disponibile */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage non disponibile */ } },
  };

  // Artista di ogni immagine ricevuta, per citarlo sotto le carte ingrandite (come chiede Scryfall)
  const artists = new Map();
  function noteArtists(value) {
    if (Array.isArray(value)) return value.forEach(noteArtists);
    if (!value || typeof value !== 'object') return;
    if (value.artist) for (const k of ['img', 'imgBack', 'art']) if (value[k]) artists.set(value[k], value.artist);
    Object.values(value).forEach(noteArtists);
  }
  const credit = (img) => (artists.get(img) ? `<div class="credit">Illustrazione di ${esc(artists.get(img))}</div>` : '');

  let ws = null;
  let S = null; // stato ricevuto dal server
  let session = store.get('ct-session'); // { room, name, pid }
  // Arrivo da un invito (/?t=<tavolo>&m=lan|auto): si entra in quel tavolo, non in quello dell'ultima volta
  const inviteParams = new URLSearchParams(location.search);
  let invited = inviteParams.get('t') ? { room: inviteParams.get('t').trim().toLowerCase().slice(0, 20), mode: inviteParams.get('m') === 'auto' ? 'auto' : 'lan' } : null;
  if (invited) {
    history.replaceState(null, '', location.pathname);
    session = null;
    store.del('ct-session');
    store.del('ct-auto-session');
  }
  let viewer = null; // finestra zona aperta: { pid, zone }
  const commanderNames = {}; // iid -> { name, color } (ricordati anche quando il comandante è nascosto)

  const ZONE_LABEL = { library: 'Grimorio', hand: 'Mano', battlefield: 'Campo', graveyard: 'Cimitero', exile: 'Esilio', command: 'Comando' };

  // Vista Arena, predefinita su telefono e computer: un avversario alla volta, carte con la sola illustrazione,
  // mano a ventaglio. Dal menu si può tornare alla vista classica (tavolo libero con tutti gli avversari).
  const arenaView = () => store.get('ct-view', 'arena') !== 'classic';
  // senza mouse il primo tocco solleva la carta dalla mano, col mouse basta passarci sopra
  const hoverQuery = matchMedia('(hover: hover)');
  const applyView = () => document.documentElement.classList.toggle('compact', arenaView());
  applyView();
  function setView(view) {
    store.set('ct-view', view);
    applyView();
    if (S) render();
    window.dispatchEvent(new Event('ct-compact'));
  }

  // ---------- Connessione ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      $('#offline').classList.add('hidden');
      if (session) ws.send(JSON.stringify({ t: 'join', ...session }));
      window.Auto?.onOpen();
      if (invited && $('#lobby-name').value.trim()) join();
    };
    ws.onmessage = (ev) => handle(JSON.parse(ev.data));
    ws.onclose = () => {
      $('#offline').classList.remove('hidden'); // avviso fisso finché il server non torna raggiungibile
      setTimeout(connect, 1500);
    };
  }

  function act(a, data = {}) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'act', a, ...data }));
  }

  function handle(msg) {
    if (String(msg.t).startsWith('auto')) return window.Auto?.handle(msg); // tavolo con regole automatiche
    if (msg.t === 'error' && window.Auto?.active()) return window.Auto.handle(msg);
    if (msg.t === 'joined') {
      session = { ...session, pid: msg.pid, room: msg.room };
      store.set('ct-session', session);
      $('#lobby').classList.add('hidden');
      $('#game').classList.remove('hidden');
    } else if (msg.t === 'state') {
      const prev = S;
      if (prev) FX.capture();
      S = msg.s;
      noteArtists(S.players);
      render();
      if (prev) {
        FX.play({ where: (key) => findCard(key.slice(1))?.zone || null });
        if (S.active !== prev.active && S.active === S.me) FX.banner('Il tuo turno');
      }
    } else if (msg.t === 'error') {
      toast(msg.msg, 5000);
      $('#lobby-error').textContent = msg.msg;
    } else if (msg.t === 'info') {
      toast(msg.msg);
    } else if (msg.t === 'deckResult') {
      let t = `Mazzo caricato: ${msg.total} carte + ${msg.commanders} comandant${msg.commanders === 1 ? 'e' : 'i'}.`;
      if (msg.notFound.length) t += ` Non trovate: ${msg.notFound.join(', ')}`;
      if (msg.notLegendary?.length) t += ` Attenzione: ${msg.notLegendary.join(', ')} non è una creatura leggendaria, controlla di aver scelto il comandante giusto.`;
      toast(t, msg.notFound.length || msg.notLegendary?.length ? 9000 : 3500);
    } else if (msg.t === 'left') {
      if (inv) closeModal(); // l'invito era per il tavolo appena lasciato
      inv = null;
      session = null;
      S = null;
      store.del('ct-session');
      $('#game').classList.add('hidden');
      $('#lobby').classList.remove('hidden');
    }
  }

  // ---------- Utilità sullo stato ----------
  const me = () => S && S.players.find((p) => p.id === S.me);
  const playerById = (id) => S.players.find((p) => p.id === id);

  function findCard(iid) {
    for (const p of S.players) {
      for (const z of ['hand', 'battlefield', 'graveyard', 'exile', 'command', 'peek']) {
        const c = (p[z] || []).find((x) => x.iid === iid);
        if (c) return { card: c, pid: p.id, zone: z === 'peek' ? 'library' : z };
      }
    }
    return null;
  }

  const canControl = (f) => f && (f.pid === S.me || f.card.owner === S.me);

  function rememberCommanders() {
    for (const p of S.players) {
      for (const z of ['command', 'battlefield', 'graveyard', 'exile', 'hand']) {
        for (const c of p[z] || []) {
          if (c.isCommander) commanderNames[c.iid] = { name: c.name, color: playerById(c.owner)?.color, owner: c.owner };
        }
      }
    }
  }

  // ---------- Rendering ----------
  function cardHtml(c, zone, pid) {
    const attrs = `data-iid="${c.iid}" data-zone="${zone}" data-pid="${pid}"`;
    const pos = zone === 'battlefield' ? `left:${c.x}%;top:${c.y}%;` : '';
    const counters = Object.entries(c.counters || {})
      .map(([k, v]) => `<span class="counter">${esc(k === '+1/+1' ? (v > 0 ? '+' + v + '/+' + v : v + '/' + v) : k + ' ' + v)}</span>`)
      .join('');
    const badges = counters ? `<div class="counters">${counters}</div>` : '';
    const tapped = c.tapped ? ' tapped' : '';
    if (c.hidden) {
      const eye = c.peekable ? '<span class="peek-eye">👁</span>' : '';
      const prev = c.peekable && c.img ? ` data-img="${esc(c.img)}"` : '';
      return `<div class="card back${tapped}" style="${pos}" ${attrs}${prev}>${eye}${badges}</div>`;
    }
    const img = c.flipped && c.imgBack ? c.imgBack : c.img;
    const token = c.token ? ' token-badge' : '';
    const tax = c.isCommander && zone === 'command' && c.casts > 0 ? `<span class="tax" title="Tassa del comandante">+${c.casts * 2}</span>` : '';
    if (!img) {
      return `<div class="card text-only${tapped}${token}" style="${pos}" ${attrs} title="${esc(c.name)}">
        <span class="tname">${esc(c.name)}</span><span class="ttype">${esc(c.type)}</span><span class="tname">${esc(c.pt || '')}</span>${badges}${tax}</div>`;
    }
    return `<div class="card${tapped}${token}" style="${pos}background-image:url('${esc(img)}')" ${attrs} data-img="${esc(img)}" title="${esc(c.name)}">${badges}${tax}</div>`;
  }

  function pileHtml(p, zone, isMe) {
    const list = p[zone] || [];
    let inner;
    if (zone === 'library') {
      inner = p.libraryCount ? '<div class="card back pile-back" style="cursor:pointer"></div>' : '<div class="zone-empty"></div>';
    } else if (zone === 'command') {
      inner = list.length
        ? `<div class="stack">${list.map((c) => cardHtml(c, 'command', p.id)).join('')}</div>`
        : '<div class="zone-empty"></div>';
    } else {
      const top = list[list.length - 1];
      inner = top ? cardHtml(top, zone, p.id) : '<div class="zone-empty"></div>';
    }
    const count = zone === 'library' ? p.libraryCount : list.length;
    const drop = isMe ? `data-drop="${zone}"` : '';
    return `<div class="zone ${zone}" ${drop} data-pile="${zone}" data-pid="${p.id}">
      <span class="zlabel">${ZONE_LABEL[zone]}</span>${inner}${zone !== 'command' ? `<span class="zcount">${count}</span>` : ''}</div>`;
  }

  function cmdChipsHtml(p, isMe) {
    const chips = [];
    const ids = new Set(Object.keys(p.cmdDmg));
    if (isMe) for (const [iid, info] of Object.entries(commanderNames)) if (info.owner !== p.id && playerById(info.owner)) ids.add(iid);
    for (const iid of ids) {
      const info = commanderNames[iid];
      if (!info) continue;
      const v = p.cmdDmg[iid] || 0;
      if (!isMe && !v) continue;
      const btn = (d, t) => (isMe ? `<button class="small" data-cmd="${iid}" data-delta="${d}">${t}</button>` : '');
      chips.push(`<span class="chip${v >= 21 ? ' lethal' : ''}" style="--cc:${info.color}" title="Danni da comandante subiti da ${esc(info.name)}">
        ${btn(-1, '−')}⚔ ${esc(info.name.split(/[ ,]/)[0])}: <b>${v}</b>${btn(1, '+')}</span>`);
    }
    return `<div class="cmd-chips">${chips.join('')}</div>`;
  }

  function panelHtml(p, isMe) {
    const btn = (attr, d, t) => (isMe ? `<button class="small" data-${attr}="${d}">${t}</button>` : '');
    const off = p.connected ? '' : ' <span class="off">(disconnesso)</span>';
    const active = S.active === p.id ? ' active' : '';
    const head = `<div class="panel-head">
      <span class="pname">${esc(p.name)}${off}${S.active === p.id ? ' ⏵' : ''}</span>
      <span class="life" title="Punti vita (Maiusc+clic: ±5)">${btn('life', -1, '−')}<b>${p.life}</b>${btn('life', 1, '+')}</span>
      <span class="stat" title="Segnalini veleno">${btn('poison', -1, '−')}<span class="ic">☠</span>${p.poison}${btn('poison', 1, '+')}</span>
      ${cmdChipsHtml(p, isMe)}
      <span class="counts">✋ ${p.handCount} · 📚 ${p.libraryCount}${!p.hasDeck && isMe ? ' · <b style="color:var(--accent)">carica un mazzo per iniziare</b>' : ''}</span>
    </div>`;
    const bf = `<div class="battlefield" data-drop="battlefield" data-pid="${p.id}">${p.battlefield.map((c) => cardHtml(c, 'battlefield', p.id)).join('')}</div>`;
    const zones = `<div class="zones">${['command', 'library', 'graveyard', 'exile'].map((z) => pileHtml(p, z, isMe)).join('')}</div>`;
    let hand = '';
    if (isMe) {
      hand = `<div class="hand" data-drop="hand" data-pile="hand" data-pid="${p.id}">${p.hand.map((c) => cardHtml(c, 'hand', p.id)).join('')}</div>`;
    } else if (p.hand) {
      hand = `<div class="hand-label">Mano rivelata</div><div class="hand">${p.hand.map((c) => cardHtml(c, 'hand', p.id)).join('')}</div>`;
    }
    return `<div class="panel${active}" style="--pc:${p.color}">${head}<div class="panel-body">${bf}${zones}</div>${hand}</div>`;
  }

  // ---------- Schermata compatta per i telefoni ----------
  let focusId = null;
  let lastActive = null;

  // Carta piccola con la sola illustrazione e il nome sopra; resta una .card, quindi si trascina e si tocca come le altre
  function miniHtml(c, zone, pid, count = 1) {
    const attrs = `data-iid="${c.iid}" data-zone="${zone}" data-pid="${pid}"`;
    const cls = ['card', 'mc'];
    if (c.tapped) cls.push('tapped');
    if (c.token) cls.push('token-badge');
    if (zone === 'command') cls.push('cmdzone');
    const counters = Object.entries(c.counters || {})
      .map(([k, v]) => `<span class="counter">${esc(k === '+1/+1' ? (v > 0 ? '+' + v + '/+' + v : v + '/' + v) : k + ' ' + v)}</span>`).join('');
    const badges = counters ? `<div class="counters">${counters}</div>` : '';
    const n = count > 1 ? `<span class="mc-n">×${count}</span>` : '';
    if (c.hidden) {
      const prev = c.peekable && c.img ? ` data-img="${esc(c.img)}"` : '';
      return `<div class="${cls.join(' ')} mc-back" ${attrs} data-fx="i${c.iid}"${prev}><span class="mc-art"></span><span class="mc-name">${c.peekable ? '👁 ' + esc(c.name || '') : 'A faccia in giù'}</span>${badges}${n}</div>`;
    }
    const img = c.flipped && c.imgBack ? c.imgBack : c.img;
    const art = (!c.flipped && c.art) || img;
    const tax = c.isCommander && zone === 'command' && c.casts > 0 ? `<span class="tax" title="Tassa del comandante">+${c.casts * 2}</span>` : '';
    const pt = c.pt ? `<span class="mc-pt">${esc(c.pt)}</span>` : '';
    return `<div class="${cls.join(' ')}" ${attrs} data-fx="i${c.iid}" data-fx-token="${c.token ? 1 : 0}" ${img ? `data-img="${esc(img)}"` : ''} title="${esc(c.name)}">
      <span class="mc-art" ${art ? `style="background-image:url('${esc(art)}')"` : ''}></span><span class="mc-name">${esc(c.name)}</span>${pt}${badges}${tax}${n}</div>`;
  }

  function compactField(p, isMe) {
    const isLand = (c) => /\bLand\b/.test(c.type || '') && !/\bCreature\b/.test(c.type || '');
    const lands = p.battlefield.filter((c) => !c.hidden && isLand(c));
    const rest = p.battlefield.filter((c) => !lands.includes(c));
    // terre uguali e nello stesso stato in una carta sola col numero (tocchi o trascini la prima)
    const groups = new Map();
    for (const c of lands) {
      const k = Object.keys(c.counters || {}).length ? c.iid : `${c.name}|${c.tapped}|${c.flipped}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const landRow = `<div class="mg-row mg-lands">${[...groups.values()].map((g) => miniHtml(g[0], 'battlefield', p.id, g.length)).join('')}</div>`;
    const cmd = isMe ? p.command.map((c) => miniHtml(c, 'command', p.id)).join('') : '';
    const mainRow = `<div class="mg-row">${rest.map((c) => miniHtml(c, 'battlefield', p.id)).join('')}${cmd}</div>`;
    const revealed = !isMe && p.hand ? `<div class="mg-row mg-lands">${p.hand.map((c) => miniHtml(c, 'hand', p.id)).join('')}</div>` : '';
    return `<div class="mg-field ${isMe ? 'mg-me' : 'mg-opp'}" data-drop="battlefield" data-pid="${p.id}" data-fx-area="f${p.id}">
      ${isMe ? mainRow + landRow : revealed + landRow + mainRow}</div>`;
  }

  function compactPile(p, zone, isMe) {
    const icon = { library: '📚', graveyard: '🪦', exile: '🌀', command: '👑' }[zone];
    const count = zone === 'library' ? p.libraryCount : (p[zone] || []).length;
    return `<span class="mz" data-pile="${zone}" data-pid="${p.id}" ${isMe ? `data-drop="${zone}"` : ''} title="${ZONE_LABEL[zone]}">${icon} ${count}</span>`;
  }

  function compactRender(mine, others) {
    if (S.active !== lastActive) {
      lastActive = S.active;
      if (S.active !== S.me && others.some((p) => p.id === S.active)) focusId = S.active;
    }
    if (!others.some((p) => p.id === focusId)) focusId = others[0]?.id;
    const opp = others.find((p) => p.id === focusId);
    const tabs = others.map((p) => {
      const cmd = Math.max(0, ...Object.values(p.cmdDmg));
      return `<button class="mg-tab ${p.id === focusId ? 'on' : ''} ${S.active === p.id ? 'active' : ''}" data-focus="${p.id}" style="--pc:${p.color}">
        <b style="color:${p.color}">${esc(p.name)}</b><span class="mg-tlife" data-fx-life="${p.id}" data-v="${p.life}">❤ ${p.life}</span><span class="muted">✋${p.handCount}</span>
        ${p.poison ? `<span>☠${p.poison}</span>` : ''}${cmd ? `<span class="${cmd >= 21 ? 'lethal' : ''}">⚔${cmd}</span>` : ''}${p.connected ? '' : '<span class="muted">⚠</span>'}</button>`;
    }).join('');
    $('#opponents').innerHTML = `<nav class="mg-tabs">${tabs || '<span class="muted">Sei solo al tavolo: usa <b>📨 Invita</b> per mandare il link ai tuoi amici.</span>'}</nav>
      ${opp ? `<div class="mg-oppwrap">${compactField(opp, false)}<div class="mg-piles">${['graveyard', 'exile'].map((z) => compactPile(opp, z, false)).join('')}</div></div>` : ''}`;
    if (!mine) { $('#me').innerHTML = ''; return; }
    const life = (attr, d, t) => `<button class="small" data-${attr}="${d}">${t}</button>`;
    $('#me').innerHTML = `<div class="mg-mid">
        <span class="mg-life ${S.active === S.me ? 'active' : ''}" data-fx-life="${mine.id}" data-v="${mine.life}">${life('life', -1, '−')} ❤ <b>${mine.life}</b> ${life('life', 1, '+')}</span>
        <span class="stat">${life('poison', -1, '−')}☠${mine.poison}${life('poison', 1, '+')}</span>
        ${cmdChipsHtml(mine, true)}
        ${mine.hasDeck ? '' : '<b style="color:var(--accent)">Carica un mazzo per iniziare</b>'}
        <span class="grow"></span>${['command', 'library', 'graveyard', 'exile'].map((z) => compactPile(mine, z, true)).join('')}
      </div>
      ${compactField(mine, true)}
      <div class="mg-hand" data-drop="hand" data-pile="hand" data-pid="${mine.id}" data-fx-area="h${mine.id}" style="--n:${mine.hand.length}">${mine.hand.map((c, k) => {
        const img = c.flipped && c.imgBack ? c.imgBack : c.img;
        return `<div class="card mg-hcard" style="--i:${k};${img ? `background-image:url('${esc(img)}')` : ''}" data-iid="${c.iid}" data-zone="hand" data-pid="${mine.id}" data-fx="i${c.iid}" ${img ? `data-img="${esc(img)}"` : ''} title="${esc(c.name)}">${img ? '' : `<span>${esc(c.name)}</span>`}</div>`;
      }).join('') || '<span class="muted">Mano vuota</span>'}</div>`;
  }

  function render() {
    if (!S) return;
    rememberCommanders();
    $('#room-code').textContent = S.code;
    const mine = me();
    const others = [];
    // Avversari nell'ordine di turno a partire da chi siede dopo di me
    const i = S.order.indexOf(S.me);
    for (let k = 1; k < S.order.length; k++) others.push(playerById(S.order[(i + k) % S.order.length]));
    if (arenaView()) compactRender(mine, others);
    else {
      $('#opponents').innerHTML = others.map((p) => panelHtml(p, false)).join('');
      $('#me').innerHTML = mine ? panelHtml(mine, true) : '';
    }
    renderLog();
    if (viewer) renderViewer();
  }

  function renderLog() {
    const el = $('#log');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.innerHTML = S.log
      .map((e) => {
        const p = e.pid && playerById(e.pid);
        const t = new Date(e.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
        return `<div><span class="muted">${t}</span> <span style="color:${p ? p.color : 'inherit'}">${esc(e.text)}</span></div>`;
      })
      .join('');
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  // ---------- Anteprima ----------
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-img]');
    if (!el) return;
    const pv = $('#preview');
    pv.style.backgroundImage = `url('${el.dataset.img}')`;
    pv.classList.add('has-img');
  });

  // ---------- Drag & drop ----------
  let drag = null;

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest('.card[data-iid]');
    if (!el || !S) return;
    const f = findCard(el.dataset.iid);
    if (!canControl(f)) return;
    const r = el.getBoundingClientRect();
    drag = { iid: el.dataset.iid, el, f, sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, started: false };
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
      drag.started = true;
      drag.ghost = drag.el.cloneNode(true);
      drag.ghost.classList.add('drag-ghost');
      drag.ghost.classList.remove('tapped');
      drag.ghost.style.width = getComputedStyle(drag.el).width;
      drag.ghost.style.left = drag.ghost.style.top = '';
      document.body.appendChild(drag.ghost);
      drag.el.classList.add('dragging-src');
      hideMenu();
    }
    drag.ghost.style.left = e.clientX - drag.ox + 'px';
    drag.ghost.style.top = e.clientY - drag.oy + 'px';
    document.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
    dropTarget(e)?.classList.add('drop-hover');
  });

  function dropTarget(e) {
    if (drag?.ghost) drag.ghost.style.display = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-drop]');
    if (drag?.ghost) drag.ghost.style.display = '';
    return el;
  }

  document.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.started) return;
    const target = dropTarget(e);
    FX.hint(`i${d.iid}`, d.ghost.getBoundingClientRect()); // la carta parte da dove l'hai lasciata
    d.ghost.remove();
    d.el.classList.remove('dragging-src');
    document.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
    if (!target) return;
    const zone = target.dataset.drop;
    const to = { zone, player: target.dataset.pid };
    if (zone === 'battlefield' && arenaView()) {
      Object.assign(to, nextSpot(d.f.card)); // sul telefono le carte stanno in file: la posizione la sceglie l'app
    } else if (zone === 'battlefield') {
      const r = target.getBoundingClientRect();
      to.x = ((e.clientX - d.ox - r.left) / r.width) * 100;
      to.y = ((e.clientY - d.oy - r.top) / r.height) * 100;
    } else if (zone === 'hand') {
      const cards = [...target.querySelectorAll('.card')].filter((c) => c.dataset.iid !== d.iid);
      to.index = cards.filter((c) => { const r = c.getBoundingClientRect(); return r.left + r.width / 2 < e.clientX; }).length;
    } else if (zone === 'library') {
      to.position = e.shiftKey ? 'bottom' : 'top';
    }
    if (zone === d.f.zone && zone !== 'battlefield' && zone !== 'hand') return;
    act('move', { iid: d.iid, to });
  });

  // ---------- Doppio clic ----------
  document.addEventListener('dblclick', (e) => {
    if (!S) return;
    const card = e.target.closest('.card[data-iid]');
    if (card && card.dataset.zone === 'battlefield') {
      const f = findCard(card.dataset.iid);
      if (canControl(f)) act('tap', { iid: card.dataset.iid });
      return;
    }
    if (card && (card.dataset.zone === 'hand' || card.dataset.zone === 'command') && card.closest('.me')) {
      playCard(card.dataset.iid);
      return;
    }
    const pile = e.target.closest('[data-pile="library"]');
    if (pile && pile.dataset.pid === S.me) act('draw', { n: 1 });
  });

  // ---------- Clic ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t.closest('#menu')) hideMenu();
    if (!S) return;

    const btn = t.closest('button');
    if (btn?.dataset.life) return act('life', { delta: Number(btn.dataset.life) * (e.shiftKey ? 5 : 1) });
    if (btn?.dataset.poison) return act('poison', { delta: Number(btn.dataset.poison) });
    if (btn?.dataset.cmd) return act('cmdDmg', { iid: btn.dataset.cmd, delta: Number(btn.dataset.delta) * (e.shiftKey ? 5 : 1) });
    if (btn?.dataset.act) return topAction(btn.dataset.act, btn);

    const tab = t.closest('[data-focus]');
    if (tab) { focusId = tab.dataset.focus; return render(); }
    const hcard = !hoverQuery.matches && t.closest('.mg-hcard');
    if (hcard) { // il primo tocco solleva la carta per leggerla; doppio tocco o trascinamento la giocano
      const was = hcard.classList.contains('raised');
      document.querySelectorAll('.mg-hcard.raised').forEach((x) => x.classList.remove('raised'));
      if (!was) hcard.classList.add('raised');
      return;
    }
    if (t.closest('.card[data-iid]') && !t.closest('[data-pile="library"]')) return;
    const pile = t.closest('[data-pile]');
    if (!pile || pile.dataset.pile === 'hand') return;
    const z = pile.dataset.pile;
    if (z === 'graveyard' || z === 'exile') openViewer(pile.dataset.pid, z);
    else if (z === 'library' && pile.dataset.pid === S.me) libraryMenu(e.clientX, e.clientY);
  });

  // ---------- Menu contestuale ----------
  document.addEventListener('contextmenu', (e) => {
    if (!S || e.target.closest('input, textarea')) return;
    const card = e.target.closest('.card[data-iid]');
    const pile = e.target.closest('[data-pile]');
    if (card) {
      e.preventDefault();
      cardMenu(card.dataset.iid, e.clientX, e.clientY);
    } else if (pile && pile.dataset.pid === S.me) {
      e.preventDefault();
      const z = pile.dataset.pile;
      if (z === 'library') libraryMenu(e.clientX, e.clientY);
      else if (z === 'graveyard') graveyardMenu(e.clientX, e.clientY);
      else if (z === 'hand') handMenu(e.clientX, e.clientY);
      else if (z === 'exile') openViewer(S.me, 'exile');
    }
  });

  function showMenu(x, y, title, items) {
    const m = $('#menu');
    m.innerHTML = (title ? `<div class="mtitle">${esc(title)}</div>` : '') +
      items.map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}">${esc(it[0])}</button>`)).join('');
    m.classList.remove('hidden');
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    m.onclick = (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      hideMenu();
      items[Number(b.dataset.i)][1]();
    };
  }
  function hideMenu() { $('#menu').classList.add('hidden'); }

  const moveTo = (iid, zone, extra = {}) => act('move', { iid, to: { zone, player: S.me, ...extra } });

  // Posizione libera sul mio campo: terre nella fila in basso, il resto in alto
  function nextSpot(card) {
    const land = /\bLand\b/.test(card?.type || '');
    const row = me().battlefield.filter((c) => /\bLand\b/.test(c.type || '') === land);
    const n = row.length;
    return { x: 2 + ((n * 7) % 84), y: (land ? 62 : 6) + Math.floor(n / 12) * 8 };
  }
  const playCard = (iid, extra = {}) => moveTo(iid, 'battlefield', { ...nextSpot(findCard(iid)?.card), ...extra });

  function moveItems(iid, f) {
    const items = [];
    const add = (z, label, extra) => { if (f.zone !== z || z === 'library') items.push([label, () => moveTo(iid, z, extra)]); };
    if (f.zone !== 'battlefield') {
      items.push(['Metti sul campo di battaglia', () => playCard(iid)]);
      items.push(['Metti sul campo a faccia in giù', () => playCard(iid, { faceDown: true })]);
    }
    add('hand', 'In mano');
    add('graveyard', 'Nel cimitero');
    add('exile', 'In esilio');
    if (f.zone !== 'exile') items.push(['In esilio a faccia in giù', () => moveTo(iid, 'exile', { faceDown: true })]);
    add('library', 'In cima al grimorio', { position: 'top' });
    add('library', 'In fondo al grimorio', { position: 'bottom' });
    if (f.card.isCommander) add('command', 'Nella zona di comando');
    return items;
  }

  function cardMenu(iid, x, y) {
    const f = findCard(iid);
    if (!f) return;
    const c = f.card;
    const title = c.hidden && !c.peekable ? 'Carta a faccia in giù' : c.name;
    if (!canControl(f)) {
      if (c.img && !c.hidden) showMenu(x, y, title, [['Ingrandisci', () => bigCard(c)]]);
      return;
    }
    const items = [];
    if (f.zone === 'command') {
      items.push([`Lancia il comandante (tassa +${c.casts * 2})`, () => playCard(iid)]);
      items.push(['In mano', () => moveTo(iid, 'hand')]);
    } else if (f.zone === 'battlefield') {
      items.push([c.tapped ? 'Stappa' : 'Tappa', () => act('tap', { iid })]);
      if (c.imgBack) items.push(['Trasforma (gira faccia)', () => act('flip', { iid })]);
      items.push([c.faceDown ? 'Gira a faccia in su' : 'Gira a faccia in giù', () => act('faceDown', { iid })]);
      items.push('-');
      items.push(['Segnalino +1/+1', () => act('counter', { iid, key: '+1/+1', delta: 1 })]);
      items.push(['Segnalino −1/−1', () => act('counter', { iid, key: '+1/+1', delta: -1 })]);
      for (const k of Object.keys(c.counters || {})) {
        if (k === '+1/+1') continue;
        items.push([`${k}: +1`, () => act('counter', { iid, key: k, delta: 1 })]);
        items.push([`${k}: −1`, () => act('counter', { iid, key: k, delta: -1 })]);
      }
      items.push(['Nuovo segnalino…', () => {
        const k = prompt('Nome del segnalino (es. carica, lealtà, tempo):');
        if (k) act('counter', { iid, key: k.trim(), delta: Number(prompt('Quanti?', '1')) || 1 });
      }]);
      items.push(['Crea un token copia', () => act('copyCard', { iid })]);
      items.push('-');
      items.push(...moveItems(iid, f));
      const others = S.players.filter((p) => p.id !== f.pid);
      if (others.length) {
        items.push('-');
        for (const p of others) items.push([`Dai il controllo a ${p.name}`, () => act('move', { iid, to: { zone: 'battlefield', player: p.id, x: c.x, y: c.y } })]);
      }
    } else {
      if (f.zone === 'hand') items.push(['Rivela a tutti', () => act('revealCard', { iid })]);
      items.push(...moveItems(iid, f));
    }
    if (c.img && !c.hidden) items.push('-', ['Ingrandisci', () => bigCard(c)]);
    showMenu(x, y, title, items);
  }

  function askNumber(label, def = 1) {
    const n = Number(prompt(label, String(def)));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function libraryMenu(x, y) {
    showMenu(x, y, 'Grimorio', [
      ['Pesca una carta', () => act('draw', { n: 1 })],
      ['Pesca N carte…', () => { const n = askNumber('Quante carte peschi?', 7); if (n) act('draw', { n }); }],
      ['Mescola', () => act('shuffle')],
      '-',
      ['Guarda le prime N carte (profetizzare)…', () => { const n = askNumber('Quante carte guardi?', 3); if (n) { act('peek', { n }); openViewer(S.me, 'peek'); } }],
      ['Cerca nel grimorio (tutto)', () => { act('peek', { n: 'all' }); openViewer(S.me, 'peek'); }],
      ['Rivela la prima carta', () => act('revealTop')],
      ['Macina N carte…', () => { const n = askNumber('Quante carte metti nel cimitero?', 1); if (n) act('mill', { n }); }],
      '-',
      ['Mulligan', () => { if (confirm('Rimescolare la mano nel grimorio e pescare 7 carte?')) act('mulligan'); }],
    ]);
  }

  function graveyardMenu(x, y) {
    showMenu(x, y, 'Cimitero', [
      ['Guarda il cimitero', () => openViewer(S.me, 'graveyard')],
      ['Rimescola tutto nel grimorio', () => act('moveZone', { from: 'graveyard', to: 'library', shuffle: true })],
      ['Esilia tutto il cimitero', () => act('moveZone', { from: 'graveyard', to: 'exile' })],
    ]);
  }

  function handMenu(x, y) {
    const mine = me();
    showMenu(x, y, 'Mano', [
      ['Mulligan', () => { if (confirm('Rimescolare la mano nel grimorio e pescare 7 carte?')) act('mulligan'); }],
      [mine.handRevealed ? 'Nascondi la mano' : 'Rivela la mano a tutti', () => act('revealHand')],
      ['Scarta tutta la mano', () => act('moveZone', { from: 'hand', to: 'graveyard' })],
    ]);
  }

  // ---------- Barra superiore ----------
  function topAction(a, btn) {
    const r = btn.getBoundingClientRect();
    const x = r.left;
    const y = r.bottom + 4;
    switch (a) {
      case 'deck': return deckModal();
      case 'builder': return window.Builder.open();
      case 'token': return tokenModal();
      case 'draw': return act('draw', { n: 1 });
      case 'dice':
        return showMenu(x, y, 'Tira un dado', [4, 6, 8, 10, 12, 20].map((s) => [`d${s}`, () => act('dice', { sides: s })])
          .concat([['Altro…', () => { const s = askNumber('Quante facce?', 100); if (s) act('dice', { sides: s }); }]]));
      case 'invite': return invite(S.code, 'lan');
      case 'more':
        return showMenu(x, y, null, [
          ['Mulligan', () => { if (confirm('Rimescolare la mano nel grimorio e pescare 7 carte?')) act('mulligan'); }],
          [me().handRevealed ? 'Nascondi la mano' : 'Rivela la mano a tutti', () => act('revealHand')],
          ['Ricomincia la partita (stesso mazzo)', () => { if (confirm('Rimettere tutte le tue carte nel mazzo e ripartire da 40 vita?')) act('restart'); }],
          '-',
          [arenaView() ? 'Vista classica (tavolo libero)' : 'Vista Arena', () => setView(arenaView() ? 'classic' : 'arena')],
          ['Invita amici…', () => invite(S.code, 'lan')],
          ['Cambia nome…', () => { const n = prompt('Nuovo nome:', me().name); if (n) { act('rename', { name: n }); session.name = n; store.set('ct-session', session); } }],
          ['Lascia il tavolo', () => { if (confirm('Lasciare il tavolo? Le tue carte verranno rimosse.')) act('leave'); }],
        ]);
      default: return act(a);
    }
  }

  // ---------- Finestre ----------
  function openModal(html) {
    $('#modal').innerHTML = html;
    $('#modal-backdrop').classList.remove('hidden');
  }
  function closeModal() {
    $('#modal-backdrop').classList.add('hidden');
    if (viewer?.zone === 'peek') act('peek', { n: null });
    viewer = null;
  }
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop' || e.target.closest('[data-close]')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideMenu(); closeModal(); return; }
    if (!S || e.target.closest('input, textarea') || !$('#modal-backdrop').classList.contains('hidden') || !$('#builder').classList.contains('hidden') || $('#game').classList.contains('hidden') || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 'd') act('draw', { n: 1 });
    else if (k === 'u') act('untapAll');
    else if (k === 't') act('startTurn');
    else if (k === 'p') act('passTurn');
  });

  function openViewer(pid, zone) {
    viewer = { pid, zone };
    renderViewer();
    $('#modal-backdrop').classList.remove('hidden');
  }

  function renderViewer() {
    const p = playerById(viewer.pid);
    if (!p) return closeModal();
    const list = (zone) => (zone === 'peek' ? p.peek || [] : p[zone] || []);
    const cards = list(viewer.zone);
    const title = viewer.zone === 'peek'
      ? (p.peekMode === 'all' ? 'Il tuo grimorio (dall\'alto)' : `Prime ${p.peekMode} carte del grimorio`)
      : `${ZONE_LABEL[viewer.zone]} di ${p.name}`;
    const zoneAttr = viewer.zone === 'peek' ? 'library' : viewer.zone;
    const extra = viewer.zone === 'peek' ? '<button data-viewer-shuffle>Mescola e chiudi</button>' : '';
    $('#modal').innerHTML = `<h2>${esc(title)} (${cards.length})</h2>
      <p class="muted">Clic destro su una carta per spostarla, oppure trascinala sul tavolo.</p>
      <div class="cards-grid">${cards.map((c) => cardHtml(c, zoneAttr, p.id)).join('') || '<span class="muted">Vuoto</span>'}</div>
      <div class="row"><span class="grow"></span>${extra}<button data-close>Chiudi</button></div>`;
    const sh = $('[data-viewer-shuffle]');
    if (sh) sh.onclick = () => { act('shuffle'); viewer = null; $('#modal-backdrop').classList.add('hidden'); };
  }

  function bigCard(c) {
    const img = c.flipped && c.imgBack ? c.imgBack : c.img;
    viewer = null;
    openModal(`<h2>${esc(c.name)}</h2><div class="row" style="justify-content:center">
      <img src="${esc(img)}" alt="${esc(c.name)}" style="max-width:min(420px,100%);border-radius:16px">
      ${c.imgBack && !c.flipped ? `<img src="${esc(c.imgBack)}" alt="" style="max-width:min(420px,100%);border-radius:16px">` : ''}
      </div><div class="row"><span class="grow"></span><button data-close>Chiudi</button></div>`);
  }

  // Interpreta le liste in formato testo (Moxfield, Archidekt, EDHREC, MTGO, Arena…)
  function parseDeck(text) {
    const main = [];
    const commanders = [];
    let section = 'main';
    let block = 0;
    let blockHasCards = false;
    for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
      let line = raw.trim();
      if (!line) {
        if (blockHasCards) { block++; blockHasCards = false; }
        continue;
      }
      const head = line.toLowerCase().replace(/^\/\/\s*/, '').replace(/[:\s]*(\(\d+\))?$/, '');
      if (['commander', 'commanders', 'comandante', 'comandanti'].includes(head)) { section = 'cmd'; continue; }
      if (['deck', 'main', 'mainboard', 'main deck', 'mazzo', 'companion'].includes(head)) { section = 'main'; continue; }
      if (['sideboard', 'maybeboard', 'considering', 'tokens', 'token'].includes(head)) { section = 'skip'; continue; }
      if (line.startsWith('//') || line.startsWith('#')) continue;
      const markedCmd = /\*cmdr\*|\[commander[^\]]*\]/i.test(line);
      line = line.replace(/\[[^\]]*\]/g, '').replace(/\*[^*]+\*/g, '').replace(/\^[^^]*\^/g, '').trim();
      let count = 1;
      let name = line;
      const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
      if (m) { count = Number(m[1]); name = m[2]; }
      name = name.replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+[\w★-]+)?\s*$/, '').replace(/\s+\d+$/, '').trim();
      if (!name || section === 'skip') continue;
      if (section === 'cmd' || markedCmd) commanders.push(name);
      else { main.push({ name, count, block }); blockHasCards = true; }
    }
    return { main, commanders, blocks: block + (blockHasCards ? 1 : 0) };
  }

  // Comandanti più probabili quando la lista non li segnala esplicitamente:
  // un ultimo blocco separato da una riga vuota con 1-2 carte (export MTGO/Arena), altrimenti la prima carta (Moxfield, EDHREC)
  function guessCommanders(d) {
    if (d.commanders.length) return d.commanders;
    const last = d.main.filter((e) => e.block === d.blocks - 1);
    if (d.blocks > 1 && last.length <= 2 && last.every((e) => e.count === 1)) return last.map((e) => e.name);
    return d.main[0]?.count === 1 ? [d.main[0].name] : [];
  }

  function deckModal() {
    viewer = null;
    const saved = store.get('ct-deck', { cmd: [], list: '' });
    let chosen = Array.isArray(saved.cmd) ? saved.cmd : String(saved.cmd || '').split(/\r?\n/).filter(Boolean);
    openModal(`<h2>Carica il tuo mazzo</h2>
      <p class="muted">Carica il file <b>.txt</b> esportato da Moxfield, Archidekt, EDHREC, MTG Arena, oppure incolla la lista qui sotto
      (formato <code>1 Sol Ring</code>, nomi in inglese). Le immagini arrivano da Scryfall: serve internet sul computer che fa da server.</p>
      <div class="row">
        <select id="deck-saved" class="grow"><option value="">— Scegli un mazzo pronto o salvato —</option></select>
        <button id="deck-saved-use" class="primary">Usa questo mazzo</button>
      </div>
      <div class="row">
        <label class="filebtn"><input id="deck-file" type="file" accept=".txt,.dek,.dck,.csv,text/plain" hidden><span>📂 Carica file .txt</span></label>
        <span id="deck-filename" class="muted"></span>
      </div>
      <label>Lista del mazzo<textarea id="deck-list" rows="14" placeholder="1 Krenko, Mob Boss&#10;1 Sol Ring&#10;1 Arcane Signet&#10;…">${esc(saved.list)}</textarea></label>
      <div class="row">
        <label class="grow">Comandante<select id="deck-cmd1" style="width:100%"></select></label>
        <label class="grow">Secondo comandante (partner, background…)<select id="deck-cmd2" style="width:100%"></select></label>
      </div>
      <div class="row"><span id="deck-count" class="muted grow"></span><button data-close>Annulla</button><button id="deck-load" class="primary">Carica e mescola</button></div>`);

    const listEl = $('#deck-list');
    const sel1 = $('#deck-cmd1');
    const sel2 = $('#deck-cmd2');

    // Ricostruisce le opzioni dei comandanti dalle carte singole della lista
    const refreshOptions = (auto) => {
      const d = parseDeck(listEl.value);
      const names = [...new Set([...d.commanders, ...d.main.filter((e) => e.count === 1).map((e) => e.name)])];
      if (auto || !chosen.every((n) => names.includes(n))) chosen = guessCommanders(d);
      const opts = (sel, empty) => `<option value="">${empty}</option>` + names.map((n) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
      sel1.innerHTML = opts(chosen[0], '— scegli —');
      sel2.innerHTML = opts(chosen[1], 'nessuno');
      update();
    };
    const collect = () => {
      const d = parseDeck(listEl.value);
      const commanders = [...new Set([sel1.value, sel2.value].filter(Boolean))];
      const main = d.main.map((e) => ({ name: e.name, count: e.count }));
      for (const c of commanders) {
        const e = main.find((x) => x.name === c);
        if (e) e.count--;
      }
      return { main: main.filter((e) => e.count > 0), commanders };
    };
    function update() {
      chosen = [sel1.value, sel2.value].filter(Boolean);
      const d = collect();
      const n = d.main.reduce((s, e) => s + e.count, 0) + d.commanders.length;
      $('#deck-count').textContent = `${n} carte in totale${n === 100 ? ' ✓' : ' (in Commander sono 100)'}`;
    }
    const loadText = (text, name) => {
      listEl.value = text;
      $('#deck-filename').textContent = name || '';
      refreshOptions(true);
    };

    let typing;
    listEl.oninput = () => { clearTimeout(typing); typing = setTimeout(() => refreshOptions(false), 300); };
    sel1.onchange = sel2.onchange = update;
    $('#deck-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (f) loadText(await f.text(), f.name);
    };
    // Si può anche trascinare il file direttamente sulla lista
    listEl.ondragover = (e) => e.preventDefault();
    listEl.ondrop = async (e) => {
      const f = e.dataTransfer.files[0];
      if (!f) return;
      e.preventDefault();
      loadText(await f.text(), f.name);
    };
    refreshOptions(false);

    let starters = [];
    const option = (d) => `<option value="${d.id}">${esc(d.name)} — ${esc(d.commanders.join(' + ') || 'senza comandante')} (${d.count})</option>`;
    Promise.all([fetch('/api/decks').then((r) => r.json()), fetch('/api/starter-decks').then((r) => r.json())]).then(([list, ready]) => {
      starters = ready;
      $('#deck-saved').innerHTML += `<optgroup label="Mazzi iniziali pronti">${ready.map(option).join('')}</optgroup>`
        + (list.length ? `<optgroup label="I miei mazzi">${list.map(option).join('')}</optgroup>` : '');
    }).catch(() => {});
    $('#deck-saved-use').onclick = async () => {
      const id = $('#deck-saved').value;
      if (!id) return toast('Scegli prima un mazzo dalla lista.');
      const d = starters.find((x) => x.id === id) || (await (await fetch('/api/decks/' + id)).json());
      act('loadDeck', { main: d.cards, commanders: d.commanders });
      closeModal();
    };

    $('#deck-load').onclick = () => {
      const d = collect();
      if (!d.main.length && !d.commanders.length) return toast('La lista è vuota.');
      if (!d.commanders.length && !confirm('Non hai scelto un comandante. Caricare comunque il mazzo?')) return;
      store.set('ct-deck', { cmd: d.commanders, list: listEl.value });
      act('loadDeck', d);
      closeModal();
    };
  }

  const COMMON_TOKENS = [
    ['Treasure', 'Tesoro'], ['Food', 'Cibo'], ['Clue', 'Indizio'], ['Blood', 'Sangue'],
    ['Soldier', 'Soldato'], ['Zombie', 'Zombie'], ['Goblin', 'Goblin'], ['Spirit', 'Spirito'],
    ['Saproling', 'Saprolingio'], ['Beast', 'Bestia'], ['Elf Warrior', 'Guerriero Elfo'], ['Human', 'Umano'],
  ];

  function tokenModal() {
    viewer = null;
    openModal(`<h2>Crea token</h2>
      <p class="muted">Scrivi il nome inglese del token: cerco l'immagine su Scryfall. Se non la trovo, creo un token di solo testo.</p>
      <div class="row">${COMMON_TOKENS.map(([en, it]) => `<button data-tok="${en}">${it}</button>`).join('')}</div>
      <div class="row">
        <input id="tok-name" class="grow" placeholder="Nome (es. Angel, Dragon, Insect)">
        <input id="tok-pt" size="5" placeholder="F/C">
        <input id="tok-n" type="number" min="1" max="20" value="1" style="width:70px">
      </div>
      <div class="row"><span class="grow"></span><button data-close>Annulla</button><button id="tok-ok" class="primary">Crea</button></div>`);
    const create = (name) => {
      act('token', { name, count: Number($('#tok-n').value) || 1, pt: $('#tok-pt').value.trim() || undefined });
      closeModal();
    };
    $('#modal').querySelectorAll('[data-tok]').forEach((b) => (b.onclick = () => create(b.dataset.tok)));
    $('#tok-ok').onclick = () => { const n = $('#tok-name').value.trim(); if (n) create(n); };
    $('#tok-name').onkeydown = (e) => { if (e.key === 'Enter') $('#tok-ok').click(); };
    $('#tok-name').focus();
  }

  // ---------- Avvisi ----------
  let toastTimer;
  function toast(text, ms = 3500) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ---------- Chat e ingresso ----------
  $('#chat').addEventListener('submit', (e) => {
    e.preventDefault();
    const i = $('#chat-input');
    if (i.value.trim()) act('chat', { text: i.value });
    i.value = '';
  });

  $('#lobby-name').value = session?.name || store.get('ct-name', '');
  if (session?.room) $('#lobby-room').value = session.room;
  $('#lobby-join').addEventListener('click', join);
  $('#lobby-builder').addEventListener('click', () => window.Builder.open());
  let joinMode = 'lan';
  const showJoin = (on, mode = 'lan') => {
    joinMode = mode;
    $('#join-title').textContent = mode === 'auto' ? 'Partita con regole automatiche' : 'Gioca in LAN';
    $('#main-menu').classList.toggle('hidden', on);
    $('#join-panel').classList.toggle('hidden', !on);
    if (on) $('#lobby-name').focus();
  };
  $('[data-menu="lan"]').addEventListener('click', () => showJoin(true, 'lan'));
  $('[data-menu="auto"]').addEventListener('click', () => showJoin(true, 'auto'));
  $('[data-menu="academy"]').addEventListener('click', () => window.Auto.academy($('#lobby-name').value.trim() || store.get('ct-name', '') || 'Allievo'));
  $('#join-back').addEventListener('click', () => showJoin(false));
  if (invited) {
    $('#lobby-room').value = invited.room;
    showJoin(true, invited.mode);
    $('#join-title').textContent = `Sei invitato al tavolo «${invited.room}»`;
    if (!$('#lobby-name').value.trim()) {
      $('#lobby-error').textContent = 'Scrivi il tuo nome e tocca "Siediti al tavolo".';
      $('#lobby-error').classList.add('hint');
    }
  }
  $('#join-panel').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  function join() {
    invited = null;
    $('#lobby-error').classList.remove('hint');
    if (joinMode === 'auto') {
      const name = $('#lobby-name').value.trim();
      if (!name) { $('#lobby-error').textContent = 'Scrivi il tuo nome.'; return; }
      store.set('ct-name', name);
      session = null;
      store.del('ct-session');
      window.Auto.join(name, $('#lobby-room').value.trim().toLowerCase() || 'tavolo');
      return;
    }
    store.del('ct-auto-session');
    const name = $('#lobby-name').value.trim();
    const room = $('#lobby-room').value.trim().toLowerCase() || 'tavolo';
    if (!name) { $('#lobby-error').textContent = 'Scrivi il tuo nome.'; return; }
    store.set('ct-name', name);
    // Se rientro nello stesso tavolo riuso il mio posto
    session = { name, room, pid: session?.room === room ? session.pid : undefined };
    $('#lobby-error').textContent = '';
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'join', ...session }));
  }

  // ---------- Inviti ----------
  // Link che fa entrare direttamente nel tavolo (con la password già dentro, se il server ne chiede una), con QR e condivisione
  let inv = null;
  async function invite(room, mode) {
    let info = { addresses: [], key: null };
    try { info = await (await fetch('/api/invite')).json(); } catch { /* resta l'indirizzo di questa pagina */ }
    const addresses = [...info.addresses];
    const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    if (!local && !addresses.some((a) => a.url === location.origin)) addresses.unshift({ url: location.origin, label: 'Questo indirizzo', note: '' });
    if (!addresses.length) addresses.push({ url: location.origin, label: 'Questo indirizzo', note: 'Dal computer del server: gli altri devono usare l\'indirizzo IP mostrato nel terminale.' });
    inv = { room, mode, key: info.key, addresses, pick: 0 };
    drawInvite();
  }

  function inviteLink() {
    const a = inv.addresses[inv.pick];
    const path = `/?t=${encodeURIComponent(inv.room)}&m=${inv.mode}`;
    return a.url + (inv.key ? `/login?k=${encodeURIComponent(inv.key)}&next=${encodeURIComponent(path)}` : path);
  }
  const inviteText = () => `Ti invito a una partita di Commander${inv.mode === 'auto' ? ' con regole automatiche' : ''} al tavolo «${inv.room}»! Apri il link ed entri subito: ${inviteLink()}`;

  function drawInvite() {
    const a = inv.addresses[inv.pick];
    const link = inviteLink();
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    viewer = null;
    openModal(`<h2>Invita amici al tavolo «${esc(inv.room)}»</h2>
      ${inv.addresses.length > 1 ? `<div class="inv-addr">${inv.addresses.map((x, i) => `<button class="${i === inv.pick ? 'on' : ''}" data-inv-addr="${i}">${esc(x.label)}</button>`).join('')}</div>` : ''}
      <div class="inv-body">
        <div class="inv-qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
        <div class="inv-side">
          <p>Chi apre il link entra direttamente in questo tavolo${inv.key ? ', senza scrivere la password' : ''}: deve solo scegliere il nome.
          Dal telefono può anche inquadrare il codice con la fotocamera.</p>
          ${a.note ? `<p class="muted small">⚠ ${esc(a.note)}</p>` : ''}
          <input class="inv-link" readonly value="${esc(link)}">
          <div class="row">
            ${navigator.share ? '<button class="primary" data-inv="share">Condividi…</button>' : ''}
            <button data-inv="whatsapp">WhatsApp</button>
            <button data-inv="copy">Copia link</button>
          </div>
        </div>
      </div>
      <div class="row"><span class="grow"></span><button data-close>Chiudi</button></div>`);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch { // senza HTTPS gli appunti non sono disponibili: si seleziona il testo e si copia alla vecchia maniera
      const field = $('.inv-link');
      field.select();
      document.execCommand('copy');
    }
    toast('Link copiato: incollalo nella chat con i tuoi amici.');
  }

  document.addEventListener('click', (e) => {
    if (!inv) return;
    const addr = e.target.closest('[data-inv-addr]');
    if (addr) { inv.pick = Number(addr.dataset.invAddr); drawInvite(); return; }
    const b = e.target.closest('[data-inv]');
    if (!b) return;
    if (b.dataset.inv === 'copy') copyText(inviteLink());
    if (b.dataset.inv === 'whatsapp') window.open(`https://wa.me/?text=${encodeURIComponent(inviteText())}`, '_blank', 'noopener');
    if (b.dataset.inv === 'share') navigator.share({ title: 'Tavolo Commander', text: inviteText().replace(/: \S+$/, ':'), url: inviteLink() }).catch(() => {});
  });

  // Funzioni condivise con l'editor dei mazzi (builder.js)
  window.CT = {
    compact: arenaView,
    hover: () => hoverQuery.matches,
    invite,
    setView,
    act, esc, toast, store, parseDeck, guessCommanders, showMenu, hideMenu, openModal, closeModal,
    send: (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    showLobby: () => { $('#lobby').classList.remove('hidden'); showJoin(false); },
    hideLobby: () => $('#lobby').classList.add('hidden'),
    inGame: () => !!S,
    playerName: () => me()?.name || store.get('ct-name', ''),
    // Carta ingrandita a tutto schermo (sui telefoni si apre con la pressione lunga)
    noteArtists,
    credit,
    zoom: (img, caption = '') => {
      viewer = null;
      openModal(`<div class="row" style="justify-content:center"><img src="${esc(img)}" alt="" class="zoom-img"></div>${credit(img)}
        ${caption ? `<p class="muted">${esc(caption)}</p>` : ''}<div class="row"><span class="grow"></span><button data-close>Chiudi</button></div>`);
    },
  };

  // ---------- App installabile (PWA) ----------
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* senza service worker l'app funziona lo stesso */ });
  }
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('#install-app').classList.remove('hidden');
  });
  $('#install-app').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('#install-app').classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => toast('App installata: la trovi tra le tue app.'));

  connect();
})();
