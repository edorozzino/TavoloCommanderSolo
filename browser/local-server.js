// Versione da telefono senza server: il codice del server delle partite con regole gira dentro la pagina.
// La pagina crede di parlare col server (WebSocket e /api/), ma i messaggi arrivano qui.
const autoplay = require('../autoplay');
const decks = require('../decks');
const { lookupCards, searchCards } = require('../scryfall');
const { STARTER_DECKS } = require('../engine/decks');

// Le partite stanno in memoria: dopo una chiusura dell'app non c'è più niente da riprendere
try { ['ct-session', 'ct-auto-session'].forEach((k) => localStorage.removeItem(k)); } catch { /* memoria non disponibile */ }

// Il tavolo libero (LAN) e gli inviti richiedono il server sul computer: qui non si mostrano
const style = document.createElement('style');
style.textContent = '[data-menu="lan"], [data-act="invite"], [data-auto="invite"], .auto-invite { display: none !important; }';
document.head.appendChild(style);

// ---------- WebSocket locale ----------
class LocalSocket {
  constructor() {
    this.readyState = 1;
    // il lato "server" che autoplay.js vede: ha anche autoRoom e pid, che ci scrive autoplay
    this.peer = { readyState: 1, OPEN: 1, send: (text) => setTimeout(() => this.onmessage?.({ data: text })) };
    setTimeout(() => this.onopen?.());
  }

  send(text) {
    const msg = JSON.parse(text);
    if (autoplay.isAutoMessage(msg)) {
      autoplay.handle(this.peer, msg).catch((e) => {
        console.error(e);
        this.peer.send(JSON.stringify({ t: 'error', msg: e.message }));
      });
    } else {
      this.peer.send(JSON.stringify({ t: 'error', msg: 'Il tavolo libero in LAN funziona solo con il server sul computer.' }));
    }
  }

  close() {}
}
window.WebSocket = LocalSocket;

// ---------- API locali (editor mazzi, carte) ----------
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function api(url, method, body) {
  const [, resource, rid] = url.pathname.split('/').filter(Boolean); // ['api', risorsa, id?]
  if (resource === 'search' && method === 'GET') {
    const q = String(url.searchParams.get('q') || '').slice(0, 500);
    if (!q.trim()) return json(400, { error: 'Ricerca vuota' });
    const page = Math.max(1, Math.min(50, Number(url.searchParams.get('page')) || 1));
    const order = ['name', 'cmc', 'edhrec', 'released', 'usd'].includes(url.searchParams.get('order')) ? url.searchParams.get('order') : 'edhrec';
    return json(200, await searchCards(q, order, page));
  }
  if (resource === 'cards' && method === 'POST') {
    const names = (Array.isArray(body.names) ? body.names : []).map(String).slice(0, 300);
    const { found, notFound } = await lookupCards(names);
    return json(200, { cards: Object.fromEntries(found), notFound });
  }
  if (resource === 'invite') return json(200, { addresses: [], key: null });
  if (resource === 'starter-decks' && method === 'GET') {
    return json(200, STARTER_DECKS.map((d, i) => ({
      id: `starter-${i}`, name: d.name, style: d.style, commanders: [d.commander], cards: d.cards, maybe: [],
      count: d.cards.reduce((n, e) => n + e.count, 0) + 1,
    })));
  }
  if (resource === 'decks') {
    if (method === 'GET' && !rid) return json(200, decks.list());
    if (method === 'GET') {
      const d = decks.get(rid);
      return d ? json(200, d) : json(404, { error: 'Mazzo non trovato' });
    }
    if (method === 'POST' && !rid) return json(200, decks.put(null, body));
    if (method === 'PUT' && rid) return json(200, decks.put(rid, body));
    if (method === 'DELETE' && rid) return json(decks.remove(rid) ? 200 : 404, {});
  }
  return json(404, { error: 'Non trovato' });
}

const networkFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  if (raw.startsWith('/api/')) {
    const method = (init.method || 'GET').toUpperCase();
    try {
      return await api(new URL(raw, 'http://locale'), method, init.body ? JSON.parse(init.body) : {});
    } catch (e) {
      return json(500, { error: e.message });
    }
  }
  // Scryfall risponde a qualunque sito, ma un User-Agent personalizzato farebbe fallire la richiesta nel browser
  if (raw.startsWith('https://api.scryfall.com/') && init.headers) {
    const headers = { ...init.headers };
    delete headers['User-Agent'];
    return networkFetch(input, { ...init, headers });
  }
  return networkFetch(input, init);
};
