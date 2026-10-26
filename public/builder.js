// Editor dei mazzi in stile YGOPro: scheda carta a sinistra, mazzo al centro, ricerca a destra.
(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const CT = window.CT;
  const esc = CT.esc;
  const toast = CT.toast;

  const ZONES = { commanders: 'Comandante', cards: 'Mazzo', maybe: 'Forse' };
  const CATEGORIES = [
    ['Terre', /\bLand\b/],
    ['Creature', /\bCreature\b/],
    ['Planeswalker', /\bPlaneswalker\b/],
    ['Battaglie', /\bBattle\b/],
    ['Istantanei', /\bInstant\b/],
    ['Stregonerie', /\bSorcery\b/],
    ['Artefatti', /\bArtifact\b/],
    ['Incantesimi', /\bEnchantment\b/],
  ];
  const COLORS = [['W', 'Bianco'], ['U', 'Blu'], ['B', 'Nero'], ['R', 'Rosso'], ['G', 'Verde']];

  let decks = []; // riepiloghi dal server
  let deck = null; // mazzo aperto: { id, name, author, commanders, cards, maybe }
  let dirty = false;
  const info = {}; // nome carta -> dati Scryfall
  let results = [];
  let page = 1;
  let hasMore = false;
  let shown = null; // carta mostrata nella scheda
  let showBack = false;

  // ---------- Utilità ----------
  async function api(path, opts = {}) {
    const res = await fetch('/api/' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Errore ' + res.status);
    return json;
  }

  async function ensureInfo(names) {
    const missing = [...new Set(names)].filter((n) => !info[n]);
    if (!missing.length) return;
    try {
      const r = await api('cards', { method: 'POST', body: { names: missing } });
      Object.assign(info, r.cards);
      CT.noteArtists(r.cards);
      if (r.notFound.length) toast('Carte non trovate su Scryfall: ' + r.notFound.join(', '), 7000);
    } catch (e) {
      toast('Impossibile contattare Scryfall: ' + e.message);
    }
  }

  const mana = (str) =>
    esc(str || '').replace(/\{([^}]+)\}/g, (_, s) => `<img class="ms" src="https://svgs.scryfall.io/card-symbols/${s.replace(/\//g, '')}.svg" alt="{${s}}">`);

  const isBasic = (n) => /\bBasic\b/.test(info[n]?.type || '');
  const category = (n) => {
    const t = info[n]?.type || '';
    return (CATEGORIES.find(([, re]) => re.test(t)) || ['Altro'])[0];
  };
  const total = (list) => list.reduce((s, e) => s + e.count, 0);
  const identity = () => {
    const ids = new Set();
    for (const c of deck.commanders) for (const x of info[c]?.colorIdentity || []) ids.add(x);
    return 'WUBRG'.split('').filter((x) => ids.has(x));
  };

  function setDirty(v = true) {
    dirty = v;
    const el = $('#b-dirty');
    if (el) el.textContent = dirty ? '● modifiche non salvate' : deck?.id ? '✓ salvato' : '';
  }

  // Problemi del mazzo rispetto alle regole Commander
  function problems() {
    const out = { list: [], byName: {} };
    const flag = (n, msg) => { (out.byName[n] ||= []).push(msg); };
    const ids = new Set(identity());
    const n = total(deck.cards) + deck.commanders.length;
    if (!deck.commanders.length) out.list.push('Manca il comandante.');
    if (n !== 100) out.list.push(`Il mazzo ha ${n} carte: in Commander devono essere esattamente 100 (comandante incluso).`);
    for (const c of deck.commanders) {
      const t = info[c]?.type || '';
      if (info[c] && !/Legendary/.test(t)) flag(c, 'Non è leggendaria: controlla che possa essere un comandante.');
    }
    for (const e of [...deck.cards, ...deck.commanders.map((name) => ({ name, count: 1 }))]) {
      const ci = info[e.name];
      if (!ci) continue;
      if (e.count > 1 && !isBasic(e.name) && !ci.anyNumber) flag(e.name, `${e.count} copie: in Commander è ammessa una sola copia.`);
      if (deck.commanders.length && !deck.commanders.includes(e.name) && ci.colorIdentity.some((x) => !ids.has(x)))
        flag(e.name, "Fuori dall'identità di colore del comandante.");
      if (ci.legal === 'banned') flag(e.name, 'Bandita in Commander.');
      else if (ci.legal !== 'legal') flag(e.name, 'Non legale in Commander.');
    }
    const dup = deck.commanders.find((c) => deck.cards.some((e) => e.name === c));
    if (dup) flag(dup, 'È sia comandante sia nel mazzo.');
    for (const [name, msgs] of Object.entries(out.byName)) out.list.push(`${name}: ${msgs.join(' ')}`);
    return out;
  }

  // ---------- Operazioni sul mazzo ----------
  function add(zone, name, n = 1) {
    if (zone === 'commanders') {
      if (deck.commanders.includes(name)) return;
      if (deck.commanders.length >= 2) return toast('Puoi avere al massimo due comandanti (partner, background…).');
      deck.commanders.push(name);
      remove('cards', name, 1, true);
    } else {
      const list = deck[zone];
      const e = list.find((x) => x.name === name);
      if (zone === 'cards' && (e || deck.commanders.includes(name)) && !isBasic(name) && !info[name]?.anyNumber) {
        return toast(`In Commander puoi avere una sola copia di ${name}.`);
      }
      if (e) e.count += n;
      else list.push({ name, count: n });
    }
    setDirty();
    renderDeck();
    renderResults();
  }

  function remove(zone, name, n = 1, silent = false) {
    if (zone === 'commanders') deck.commanders = deck.commanders.filter((x) => x !== name);
    else {
      const e = deck[zone].find((x) => x.name === name);
      if (!e) return;
      e.count -= n;
      if (e.count <= 0) deck[zone] = deck[zone].filter((x) => x !== e);
    }
    if (silent) return;
    setDirty();
    renderDeck();
    renderResults();
  }

  function move(from, to, name) {
    if (from === to) return;
    if (to === 'commanders' && deck.commanders.length >= 2) return toast('Puoi avere al massimo due comandanti.');
    remove(from, name, 1, true);
    add(to, name);
  }

  // ---------- Archivio mazzi ----------
  async function refreshList() {
    try {
      decks = await api('decks');
    } catch (e) {
      decks = [];
      toast('Impossibile leggere i mazzi salvati: ' + e.message);
    }
    renderDeckSelect();
  }

  const confirmDiscard = () => !dirty || confirm('Ci sono modifiche non salvate. Continuare e perderle?');

  async function openDeck(id) {
    const d = await api('decks/' + id);
    deck = { maybe: [], ...d };
    CT.store.set('ct-last-deck', id);
    setDirty(false);
    renderAll();
    await ensureInfo([...deck.commanders, ...deck.cards.map((e) => e.name), ...deck.maybe.map((e) => e.name)]);
    renderAll();
    search(true);
  }

  function newDeck(from = {}) {
    deck = { id: null, name: 'Nuovo mazzo', author: CT.playerName(), commanders: [], cards: [], maybe: [], ...from };
    setDirty(!!from.cards);
    renderAll();
    search(true);
  }

  async function save(asNew = false) {
    if (asNew || !deck.id) {
      const name = asNew || !deck.id ? prompt('Nome del mazzo:', asNew ? deck.name + ' (copia)' : deck.name) : deck.name;
      if (!name) return false;
      deck.name = name.trim();
    }
    const body = { name: deck.name, author: deck.author || CT.playerName(), commanders: deck.commanders, cards: deck.cards, maybe: deck.maybe };
    const saved = asNew || !deck.id ? await api('decks', { method: 'POST', body }) : await api('decks/' + deck.id, { method: 'PUT', body });
    deck.id = saved.id;
    CT.store.set('ct-last-deck', saved.id);
    setDirty(false);
    await refreshList();
    renderTop();
    toast(`Mazzo "${deck.name}" salvato.`);
    return true;
  }

  function exportText() {
    const lines = [...deck.commanders.map((c) => `1 ${c}`), ...deck.cards.map((e) => `${e.count} ${e.name}`)];
    if (deck.maybe.length) lines.push('', 'Maybeboard', ...deck.maybe.map((e) => `${e.count} ${e.name}`));
    return lines.join('\n') + '\n';
  }

  function download() {
    const blob = new Blob([exportText()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (deck.name || 'mazzo').replace(/[\\/:*?"<>|]/g, '_') + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Crea un mazzo da una lista in testo (file .txt o testo incollato)
  async function importText(text, name) {
    if (!confirmDiscard()) return;
    const d = CT.parseDeck(text);
    const commanders = CT.guessCommanders(d).slice(0, 2);
    const cards = d.main.map((e) => ({ name: e.name, count: e.count }));
    for (const c of commanders) {
      const e = cards.find((x) => x.name === c);
      if (e && --e.count === 0) cards.splice(cards.indexOf(e), 1);
    }
    newDeck({ name: name || 'Mazzo importato', commanders, cards });
    await ensureInfo([...commanders, ...cards.map((e) => e.name)]);
    renderAll();
    search(true);
    toast('Lista importata: controlla il comandante e premi Salva.', 5000);
  }

  function importModal() {
    CT.openModal(`<h2>Importa un mazzo</h2>
      <p class="muted">Carica il file .txt esportato da Moxfield, Archidekt, EDHREC o Arena, oppure incolla la lista.</p>
      <div class="row"><label class="filebtn"><input id="bi-file" type="file" accept=".txt,.dek,.dck,.csv,text/plain" hidden><span>📂 Scegli file .txt</span></label></div>
      <textarea id="bi-text" rows="12" placeholder="1 Krenko, Mob Boss&#10;1 Sol Ring&#10;…"></textarea>
      <div class="row"><span class="grow"></span><button data-close>Annulla</button><button id="bi-ok" class="primary">Importa</button></div>`);
    $('#bi-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      CT.closeModal();
      importText(await f.text(), f.name.replace(/\.[^.]+$/, ''));
    };
    $('#bi-ok').onclick = () => {
      const t = $('#bi-text').value;
      if (!t.trim()) return;
      CT.closeModal();
      importText(t, 'Mazzo importato');
    };
  }

  function testHand() {
    const pool = deck.cards.flatMap((e) => Array(e.count).fill(e.name));
    if (!pool.length) return toast('Il mazzo è vuoto.');
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let drawn = 7;
    const draw = () => {
      $('#th-cards').innerHTML = pool.slice(0, drawn)
        .map((n) => `<img src="${esc(info[n]?.img || '')}" alt="${esc(n)}" title="${esc(n)}">`).join('');
      $('#th-info').textContent = `${drawn} carte pescate · ${pool.slice(0, drawn).filter((n) => category(n) === 'Terre').length} terre`;
    };
    CT.openModal(`<h2>Mano di prova</h2><div id="th-cards" class="th-cards"></div>
      <div class="row"><span id="th-info" class="muted grow"></span><button id="th-draw">Pesca</button><button id="th-new">Nuova mano</button><button data-close>Chiudi</button></div>`);
    $('#th-draw').onclick = () => { if (drawn < pool.length) drawn++; draw(); };
    $('#th-new').onclick = () => { CT.closeModal(); testHand(); };
    draw();
  }

  // ---------- Ricerca ----------
  let searchTimer;
  function searchSoon() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(true), 400);
  }

  function buildQuery() {
    const v = (id) => $('#' + id)?.value.trim() || '';
    const parts = [];
    const text = v('bs-text');
    const mode = v('bs-mode');
    if (text) {
      if (mode === 'raw') parts.push(text);
      else if (mode === 'oracle') parts.push(...text.split(/\s+/).map((w) => `o:"${w.replace(/"/g, '')}"`));
      else parts.push(text.replace(/[:"()<>=]/g, ' '));
    }
    const type = v('bs-type');
    if (type) parts.push(type);
    const sub = v('bs-sub');
    // Senza comandante e senza filtri propongo i comandanti più giocati
    if (!deck.commanders.length && !text && !type && !sub) parts.push('is:commander');
    if (sub) parts.push(...sub.split(/\s+/).map((w) => 't:' + w.replace(/[:"]/g, '')));
    const cols = [...document.querySelectorAll('#builder .bs-color.on')].map((b) => b.dataset.c);
    if (cols.includes('C')) parts.push('c=c');
    else if (cols.length) parts.push('c>=' + cols.join(''));
    const cmc = v('bs-cmc');
    if (cmc) parts.push(cmc === '7' ? 'cmc>=7' : 'cmc=' + cmc);
    const rarity = v('bs-rarity');
    if (rarity) parts.push('r:' + rarity);
    if ($('#bs-identity')?.checked && deck.commanders.length) parts.push('id<=' + (identity().join('') || 'c'));
    if ($('#bs-legal')?.checked) parts.push('f:commander');
    parts.push('game:paper');
    return parts.join(' ');
  }

  async function search(reset) {
    if (!$('#bs-results')) return;
    if (reset) { page = 1; results = []; }
    const q = buildQuery();
    $('#bs-status').textContent = 'Cerco…';
    try {
      const r = await api(`search?q=${encodeURIComponent(q)}&order=${$('#bs-order').value}&page=${page}`);
      if (r.error) {
        $('#bs-status').textContent = r.error;
        results = [];
      } else {
        for (const c of r.cards) info[c.name] = c;
        CT.noteArtists(r.cards);
        results = reset ? r.cards : results.concat(r.cards);
        hasMore = r.hasMore;
        $('#bs-status').textContent = r.total ? `${r.total} risultati` : 'Nessun risultato';
      }
    } catch (e) {
      $('#bs-status').textContent = 'Errore: ' + e.message;
    }
    renderResults();
  }

  // ---------- Rendering ----------
  function renderAll() {
    renderTop();
    renderInfo();
    renderDeck();
    renderResults();
  }

  function renderDeckSelect() {
    const sel = $('#b-select');
    if (!sel) return;
    const cur = deck?.id || '';
    sel.innerHTML = (deck && !deck.id ? `<option value="" selected>${esc(deck.name)} (non salvato)</option>` : '') +
      decks.map((d) => `<option value="${d.id}" ${d.id === cur ? 'selected' : ''}>${esc(d.name)} — ${esc(d.commanders.join(' + ') || 'senza comandante')} (${d.count})</option>`).join('') +
      (!decks.length && deck?.id ? '' : '');
  }

  function renderTop() {
    renderDeckSelect();
    $('#b-name').textContent = deck.name;
    $('#b-play').classList.toggle('hidden', !CT.inGame());
    setDirty(dirty);
  }

  function renderInfo() {
    const el = $('#b-info');
    const c = shown && info[shown];
    if (!c) {
      el.innerHTML = '<p class="muted">Passa il mouse sopra una carta per vederne i dettagli.</p>';
      return;
    }
    const img = showBack && c.imgBack ? c.imgBack : c.img;
    const legal = { legal: ['ok', 'Legale in Commander'], banned: ['bad', 'Bandita in Commander'] }[c.legal] || ['bad', 'Non legale in Commander'];
    const pt = c.power != null ? `<div class="bi-pt">${esc(c.power)}/${esc(c.toughness)}</div>` : '';
    el.innerHTML = `
      ${img ? `<img class="bi-img" src="${esc(img)}" alt="${esc(c.name)}">${CT.credit(img)}` : ''}
      ${c.imgBack ? '<button id="bi-flip" class="small">↻ Gira la carta</button>' : ''}
      <div class="bi-name">${esc(c.name)} <span class="bi-cost">${mana(c.manaCost)}</span></div>
      <div class="bi-type">${esc(c.type)}</div>
      <div class="bi-text">${mana(c.oracle || '').replace(/\n/g, '<br>')}</div>
      ${pt}
      <div class="bi-legal ${legal[0]}">${legal[1]}</div>`;
    const flip = $('#bi-flip');
    if (flip) flip.onclick = () => { showBack = !showBack; renderInfo(); };
  }

  function show(name) {
    if (shown === name || !info[name]) return;
    shown = name;
    showBack = false;
    renderInfo();
  }

  function tileHtml(zone, name, count, warn) {
    const c = info[name];
    const img = c?.img ? `background-image:url('${esc(c.img)}')` : '';
    const banned = c?.legal === 'banned' ? '<span class="bt-ban">BAN</span>' : '';
    return `<div class="b-tile${warn ? ' warn' : ''}${c?.img ? '' : ' noimg'}" style="${img}" draggable="true"
      data-bname="${esc(name)}" data-bzone="${zone}" title="${esc(name)}${warn ? '\n⚠ ' + esc(warn.join(' ')) : ''}">
      ${c?.img ? '' : `<span>${esc(name)}</span>`}${count > 1 ? `<span class="bt-count">×${count}</span>` : ''}${banned}</div>`;
  }

  function renderDeck() {
    const el = $('#b-deck');
    if (!el || !deck) return;
    const pr = problems();
    const sort = $('#b-sort')?.value || 'type';
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name),
      cmc: (a, b) => (info[a.name]?.cmc ?? 99) - (info[b.name]?.cmc ?? 99) || a.name.localeCompare(b.name),
    };
    const listHtml = (zone, list) => {
      const sorted = [...list].sort(cmp.cmc);
      if (sort !== 'type' || zone === 'maybe') {
        return `<div class="b-grid">${[...list].sort(cmp[sort] || cmp.cmc).map((e) => tileHtml(zone, e.name, e.count, pr.byName[e.name])).join('')}</div>`;
      }
      const groups = {};
      for (const e of sorted) (groups[category(e.name)] ||= []).push(e);
      return [...CATEGORIES.map(([k]) => k), 'Altro'].filter((k) => groups[k]).map((k) =>
        `<div class="b-group"><div class="b-ghead">${k} (${total(groups[k])})</div>
          <div class="b-grid">${groups[k].map((e) => tileHtml(zone, e.name, e.count, pr.byName[e.name])).join('')}</div></div>`).join('');
    };

    // Curva di mana delle carte non terra
    const curve = Array(8).fill(0);
    for (const e of deck.cards) if (category(e.name) !== 'Terre' && info[e.name]) curve[Math.min(7, Math.floor(info[e.name].cmc))] += e.count;
    const max = Math.max(1, ...curve);
    const curveHtml = curve.map((v, i) => `<div class="bc-col" title="Costo ${i === 7 ? '7+' : i}: ${v} carte">
      <span class="bc-v">${v || ''}</span><div class="bc-bar" style="height:${(v / max) * 100}%"></div><span class="bc-l">${i === 7 ? '7+' : i}</span></div>`).join('');

    const n = total(deck.cards);
    const all = n + deck.commanders.length;
    const lands = deck.cards.filter((e) => category(e.name) === 'Terre').reduce((s, e) => s + e.count, 0);
    const creatures = deck.cards.filter((e) => category(e.name) === 'Creature').reduce((s, e) => s + e.count, 0);
    const ids = identity();

    el.innerHTML = `
      <div class="b-summary">
        <span class="b-total ${all === 100 ? 'ok' : ''}">${all}/100</span>
        <span>Creature ${creatures} · Terre ${lands} · Altre ${n - lands - creatures}</span>
        <span class="b-ident">${ids.length ? ids.map((c) => mana(`{${c}}`)).join('') : deck.commanders.length ? mana('{C}') : ''}</span>
        <div class="b-curve" title="Curva di mana (carte non terra)">${curveHtml}</div>
      </div>
      <div class="b-zone cmd" data-bdrop="commanders">
        <div class="b-zhead">Comandante <span class="muted">(${deck.commanders.length}/2) — trascina qui una creatura leggendaria</span></div>
        <div class="b-grid">${deck.commanders.map((c) => tileHtml('commanders', c, 1, pr.byName[c])).join('') || '<span class="muted b-empty">Nessun comandante</span>'}</div>
      </div>
      <div class="b-zone" data-bdrop="cards">
        <div class="b-zhead">Mazzo <span class="muted">(${n}/${100 - Math.max(1, deck.commanders.length)})</span></div>
        ${listHtml('cards', deck.cards) || '<span class="muted b-empty">Trascina qui le carte dai risultati, o fai doppio clic su un risultato.</span>'}
      </div>
      <div class="b-zone maybe" data-bdrop="maybe">
        <div class="b-zhead">Forse <span class="muted">(${total(deck.maybe)}) — carte da valutare, non entrano in partita</span></div>
        ${listHtml('maybe', deck.maybe) || '<span class="muted b-empty">Vuoto</span>'}
      </div>
      ${pr.list.length ? `<div class="b-warn"><b>⚠ Da controllare</b><ul>${pr.list.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : '<div class="b-ok">✓ Mazzo valido per Commander</div>'}`;
  }

  function renderResults() {
    const el = $('#bs-results');
    if (!el || !deck) return;
    const inDeck = (n) => (deck.commanders.includes(n) ? 1 : 0) + (deck.cards.find((e) => e.name === n)?.count || 0);
    el.innerHTML = results.map((c) => {
      const k = inDeck(c.name);
      return `<div class="bs-row" draggable="true" data-bname="${esc(c.name)}" data-bzone="search">
        ${c.img ? `<img src="${esc(c.img)}" alt="" loading="lazy">` : '<span class="bs-noimg"></span>'}
        <div class="bs-meta"><div class="bs-name">${esc(c.name)}</div>
          <div class="bs-type">${esc(c.type)}</div><div>${mana(c.manaCost)}</div></div>
        ${k ? `<span class="bs-in" title="Già nel mazzo">×${k}</span>` : ''}
        ${c.legal === 'banned' ? '<span class="bt-ban">BAN</span>' : ''}
        <div class="bs-btns"><button class="small" data-badd="cards" title="Aggiungi al mazzo">+</button>${/Legendary/.test(c.type) ? '<button class="small" data-badd="commanders" title="Imposta come comandante">👑</button>' : ''}</div>
      </div>`;
    }).join('') + (hasMore ? '<button id="bs-more" class="bs-more">Carica altri risultati</button>' : '');
    const more = $('#bs-more');
    if (more) more.onclick = () => { page++; search(false); };
  }

  // ---------- Struttura ----------
  function buildShell() {
    $('#builder').innerHTML = `
      <header class="b-top">
        <b class="b-title">Editor mazzi</b>
        <select id="b-select" title="Apri un mazzo salvato"></select>
        <button data-b="new">Nuovo</button>
        <button data-b="save" class="primary">Salva</button>
        <button data-b="saveas">Salva con nome</button>
        <button data-b="rename">Rinomina</button>
        <button data-b="delete">Elimina</button>
        <span class="b-sep"></span>
        <button data-b="import">Importa .txt</button>
        <button data-b="starter">Mazzi iniziali</button>
        <button data-b="export">Esporta .txt</button>
        <span class="b-sep"></span>
        <button data-b="clear">Svuota</button>
        <button data-b="hand">Mano di prova</button>
        <span class="b-sep"></span>
        <button id="b-play" data-b="play" class="primary">Gioca con questo mazzo</button>
        <button data-b="close">Chiudi</button>
      </header>
      <aside id="b-info" class="b-info"></aside>
      <main class="b-center">
        <div class="b-head"><h2 id="b-name"></h2><span id="b-dirty" class="muted"></span>
          <label class="b-sortlbl">Ordina per <select id="b-sort"><option value="type">Tipo</option><option value="cmc">Costo</option><option value="name">Nome</option></select></label></div>
        <div id="b-deck"></div>
      </main>
      <aside class="b-search" data-bdrop="remove">
        <div class="bs-form">
          <div class="bs-line"><input id="bs-text" placeholder="Cerca carte…" autocomplete="off">
            <select id="bs-mode" title="Dove cercare"><option value="name">Nome</option><option value="oracle">Testo</option><option value="raw">Sintassi Scryfall</option></select></div>
          <div class="bs-line">
            <select id="bs-type"><option value="">Tutti i tipi</option><option value="t:creature">Creatura</option><option value="t:instant">Istantaneo</option>
              <option value="t:sorcery">Stregoneria</option><option value="t:artifact">Artefatto</option><option value="t:enchantment">Incantesimo</option>
              <option value="t:planeswalker">Planeswalker</option><option value="t:land">Terra</option><option value="t:battle">Battaglia</option>
              <option value="t:legendary">Leggendaria</option><option value="is:commander">Può essere comandante</option></select>
            <input id="bs-sub" placeholder="Sottotipo (es. Goblin)" autocomplete="off">
          </div>
          <div class="bs-line bs-colors">${COLORS.map(([c, l]) => `<button class="bs-color" data-c="${c}" title="${l}">${mana(`{${c}}`)}</button>`).join('')}
            <button class="bs-color" data-c="C" title="Incolore">${mana('{C}')}</button>
            <select id="bs-cmc" title="Valore di mana"><option value="">Costo: tutti</option>${[0, 1, 2, 3, 4, 5, 6].map((i) => `<option value="${i}">Costo ${i}</option>`).join('')}<option value="7">Costo 7+</option></select>
          </div>
          <div class="bs-line">
            <select id="bs-rarity"><option value="">Tutte le rarità</option><option value="common">Comune</option><option value="uncommon">Non comune</option><option value="rare">Rara</option><option value="mythic">Mitica</option></select>
            <select id="bs-order" title="Ordine dei risultati"><option value="edhrec">Più giocate (EDHREC)</option><option value="name">Nome</option><option value="cmc">Costo</option><option value="released">Più recenti</option><option value="usd">Prezzo</option></select>
          </div>
          <label class="bs-check"><input type="checkbox" id="bs-identity" checked> Solo carte nell'identità di colore del comandante</label>
          <label class="bs-check"><input type="checkbox" id="bs-legal" checked> Solo carte legali in Commander</label>
          <div id="bs-status" class="muted"></div>
        </div>
        <div id="bs-results" class="bs-results"></div>
        <div class="bs-hint muted">Doppio clic o “+” per aggiungere · trascina sul mazzo · trascina qui una carta del mazzo per toglierla</div>
      </aside>`;
    bindShell();
  }

  function bindShell() {
    const root = $('#builder');
    const actions = {
      async new() { if (confirmDiscard()) newDeck(); },
      async save() { await save(false); },
      async saveas() { await save(true); },
      async rename() {
        const n = prompt('Nuovo nome del mazzo:', deck.name);
        if (!n) return;
        deck.name = n.trim();
        if (deck.id) await save(false);
        else renderTop();
      },
      async delete() {
        if (!deck.id) { if (confirmDiscard()) newDeck(); return; }
        if (!confirm(`Eliminare definitivamente il mazzo "${deck.name}"?`)) return;
        await api('decks/' + deck.id, { method: 'DELETE' });
        dirty = false;
        await refreshList();
        if (decks[0]) await openDeck(decks[0].id);
        else newDeck();
      },
      import: importModal,
      async starter() {
        const list = await api('starter-decks');
        CT.showMenu(innerWidth / 2 - 120, 60, 'Copia un mazzo iniziale', list.map((d) => [`${d.name} (${d.style})`, async () => {
          if (!confirmDiscard()) return;
          newDeck({ name: d.name, commanders: [...d.commanders], cards: d.cards.map((e) => ({ ...e })) });
          await ensureInfo([...d.commanders, ...d.cards.map((e) => e.name)]);
          renderAll();
          search(true);
          toast('Mazzo iniziale copiato: premi Salva per tenerlo tra i tuoi.', 5000);
        }]));
      },
      export: download,
      clear() {
        if (!confirm('Togliere tutte le carte dal mazzo (comandante compreso)?')) return;
        Object.assign(deck, { commanders: [], cards: [], maybe: [] });
        setDirty();
        renderDeck();
        renderResults();
      },
      hand: testHand,
      async play() {
        if (!deck.commanders.length && !confirm('Il mazzo non ha un comandante. Usarlo comunque?')) return;
        if (dirty && confirm('Salvare le modifiche prima di giocare?')) await save(false);
        CT.act('loadDeck', { main: deck.cards, commanders: deck.commanders });
        close(true);
      },
      close: () => close(false),
    };
    root.querySelectorAll('[data-b]').forEach((b) => (b.onclick = () => Promise.resolve().then(() => actions[b.dataset.b]()).catch((e) => toast(e.message))));

    $('#b-select').onchange = async (e) => {
      const id = e.target.value;
      if (!id || id === deck?.id) return;
      if (!confirmDiscard()) { renderDeckSelect(); return; }
      await openDeck(id);
    };
    $('#b-sort').onchange = renderDeck;

    for (const id of ['bs-text', 'bs-sub']) $('#' + id).oninput = searchSoon;
    for (const id of ['bs-mode', 'bs-type', 'bs-cmc', 'bs-rarity', 'bs-order', 'bs-identity', 'bs-legal']) $('#' + id).onchange = () => search(true);
    root.querySelectorAll('.bs-color').forEach((b) => (b.onclick = () => {
      b.classList.toggle('on');
      if (b.dataset.c === 'C' && b.classList.contains('on')) root.querySelectorAll('.bs-color:not([data-c="C"])').forEach((x) => x.classList.remove('on'));
      else if (b.dataset.c !== 'C') root.querySelector('.bs-color[data-c="C"]').classList.remove('on');
      search(true);
    }));

    // Scheda carta al passaggio del mouse
    root.addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-bname]');
      if (el) show(el.dataset.bname);
    });

    // Pulsanti dei risultati e doppio clic
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-badd]');
      if (b) add(b.dataset.badd, b.closest('[data-bname]').dataset.bname);
    });
    root.addEventListener('dblclick', (e) => {
      const el = e.target.closest('[data-bname]');
      if (!el || e.target.closest('button')) return;
      if (el.dataset.bzone === 'search') add('cards', el.dataset.bname);
      else if (el.dataset.bzone === 'cards' && (isBasic(el.dataset.bname) || info[el.dataset.bname]?.anyNumber)) add('cards', el.dataset.bname);
    });

    // Menu col tasto destro
    root.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('[data-bname]');
      if (!el) return;
      e.preventDefault();
      const name = el.dataset.bname;
      const zone = el.dataset.bzone;
      const items = [];
      const legendary = /Legendary/.test(info[name]?.type || '');
      if (zone === 'search') {
        items.push(['Aggiungi al mazzo', () => add('cards', name)]);
        if (legendary) items.push(['Imposta come comandante', () => add('commanders', name)]);
        items.push(['Aggiungi a "Forse"', () => add('maybe', name)]);
      } else {
        if (zone !== 'commanders' && (zone === 'maybe' || isBasic(name) || info[name]?.anyNumber)) items.push(['Aggiungi una copia', () => add(zone, name)]);
        items.push([zone === 'commanders' ? 'Togli il comandante' : 'Togli una copia', () => remove(zone, name)]);
        const e2 = zone !== 'commanders' && deck[zone].find((x) => x.name === name);
        if (e2 && e2.count > 1) items.push(['Togli tutte le copie', () => remove(zone, name, e2.count)]);
        items.push('-');
        if (zone !== 'commanders' && legendary) items.push(['Imposta come comandante', () => move(zone, 'commanders', name)]);
        if (zone !== 'cards') items.push(['Sposta nel mazzo', () => move(zone, 'cards', name)]);
        if (zone !== 'maybe') items.push(['Sposta in "Forse"', () => move(zone, 'maybe', name)]);
      }
      if (info[name]?.img) items.push('-', ['Ingrandisci', () => CT.zoom(info[name].img, name)]);
      CT.showMenu(e.clientX, e.clientY, name, items);
    });

    // Trascinamento tra risultati e zone del mazzo
    root.addEventListener('dragstart', (e) => {
      const el = e.target.closest('[data-bname]');
      if (!el) return;
      e.dataTransfer.setData('text/plain', JSON.stringify({ name: el.dataset.bname, from: el.dataset.bzone }));
      e.dataTransfer.effectAllowed = 'move';
    });
    root.addEventListener('dragover', (e) => {
      const z = e.target.closest('[data-bdrop]');
      if (!z) return;
      e.preventDefault();
      root.querySelectorAll('.drop-hover').forEach((x) => x !== z && x.classList.remove('drop-hover'));
      z.classList.add('drop-hover');
    });
    root.addEventListener('dragleave', (e) => {
      const z = e.target.closest('[data-bdrop]');
      if (z && !z.contains(e.relatedTarget)) z.classList.remove('drop-hover');
    });
    root.addEventListener('drop', (e) => {
      const z = e.target.closest('[data-bdrop]');
      root.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
      if (!z) return;
      e.preventDefault();
      let d;
      try { d = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      const to = z.dataset.bdrop;
      if (to === 'remove') { if (d.from !== 'search') remove(d.from, d.name); return; }
      if (d.from === 'search') add(to, d.name);
      else move(d.from, to, d.name);
    });
  }

  // ---------- Apertura e chiusura ----------
  async function open() {
    CT.hideMenu();
    if (!$('#builder').children.length) buildShell();
    $('#builder').classList.remove('hidden');
    await refreshList();
    if (!deck) {
      const last = CT.store.get('ct-last-deck');
      const pick = decks.find((d) => d.id === last) || decks[0];
      if (pick) await openDeck(pick.id);
      else newDeck();
    } else {
      renderAll();
    }
  }

  function close(force) {
    if (!force && !confirmDiscard()) return;
    if (dirty) deck = null; // le modifiche scartate non restano in memoria
    dirty = false;
    $('#builder').classList.add('hidden');
  }

  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  window.Builder = { open };
})();
