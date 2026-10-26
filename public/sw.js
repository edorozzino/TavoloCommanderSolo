// Service worker: l'interfaccia resta disponibile anche quando il server non risponde.
// Le partite richiedono comunque il server (WebSocket): senza, l'app mostra un avviso.
// I percorsi sono relativi al service worker: il sito può stare anche in una sottocartella (GitHub Pages)
const VERSION = 'tavolo-commander-v5';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'builder.js', 'auto.js', 'mobile.js', 'fx.js', 'vendor/qrcode.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon.svg',
];
const SHARED_ASSETS = ['svgs.scryfall.io', 'fonts.googleapis.com', 'fonts.gstatic.com']; // simboli di mana e caratteri

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/api/')) return; // dati sempre dal server
    // prima la rete (così gli aggiornamenti arrivano subito), poi la cache
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
    );
    return;
  }
  if (SHARED_ASSETS.includes(url.hostname)) {
    // simboli e caratteri cambiano raramente: dalla cache, aggiornando in background
    event.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
  }
});
