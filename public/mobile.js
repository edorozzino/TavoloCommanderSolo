// Comandi touch per telefoni e tablet: pressione lunga al posto del tasto destro, doppio tocco al posto del doppio clic,
// e un invito a ruotare il telefono in orizzontale durante le partite.
(() => {
  const $ = (s) => document.querySelector(s);
  const LONG_PRESS = 500;
  const MOVE_TOLERANCE = 10;
  const DOUBLE_TAP = 320;

  // ---------- Pressione lunga → menu contestuale (o carta ingrandita) ----------
  let press = null;
  let suppressClickUntil = 0;

  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    clearTimeout(press?.timer);
    const target = e.target;
    press = { x: e.clientX, y: e.clientY, target, native: false };
    press.timer = setTimeout(() => {
      if (!press || press.native) return;
      longPress(press.target, press.x, press.y);
      press = null;
    }, LONG_PRESS);
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (press && e.pointerType === 'touch' && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
  }, true);
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, (e) => { if (e.pointerType === 'touch') cancelPress(); }, true);

  function cancelPress() {
    clearTimeout(press?.timer);
    press = null;
  }

  // Android apre già da solo il menu con la pressione lunga: in quel caso non lo riapriamo
  document.addEventListener('contextmenu', (e) => {
    if (press && e.isTrusted) {
      press.native = true;
      suppressClickUntil = Date.now() + 700;
    }
  }, true);

  function longPress(target, x, y) {
    if (target.closest('input, textarea, select')) return;
    suppressClickUntil = Date.now() + 700;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
    target.dispatchEvent(ev);
    if (!ev.defaultPrevented) zoomCard(target); // nessun menu per questo elemento: ingrandiamo la carta, se c'è
    navigator.vibrate?.(15);
  }

  // Il tocco che chiude una pressione lunga non deve anche "cliccare" (per esempio chiudere il menu appena aperto)
  document.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
      suppressClickUntil = 0;
    }
  }, true);

  function cardImage(el) {
    const card = el.closest('[data-img], [data-oid], [data-pick], [data-scry], [data-bname], .card');
    if (!card) return null;
    if (card.dataset.img) return card.dataset.img;
    const inner = card.querySelector('img');
    if (inner) return inner.src;
    const bg = getComputedStyle(card).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    return bg ? bg[1] : null;
  }

  function zoomCard(target) {
    const img = cardImage(target);
    if (img) window.CT?.zoom(img, target.closest('[title]')?.title || '');
  }

  // ---------- Doppio tocco → doppio clic ----------
  // I browser mobili gestiscono il doppio tocco in modo diverso tra loro: lo generiamo noi, sempre uguale
  let lastTap = null;
  // la carta toccata può essere ridisegnata tra un tocco e l'altro: la riconosciamo dal suo identificativo
  const tapKey = (el) => {
    const card = el.closest('[data-iid], [data-oid], [data-bname], [data-pile]');
    return card ? `${card.dataset.iid || ''}|${card.dataset.oid || ''}|${card.dataset.bname || ''}|${card.dataset.pile || ''}|${card.dataset.pid || ''}` : el;
  };
  document.addEventListener('dblclick', (e) => {
    if (e.isTrusted && lastTap?.touch) e.stopImmediatePropagation();
  }, true);
  document.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') {
      lastTap = null;
      return;
    }
    const now = Date.now();
    const target = e.target;
    const key = tapKey(target);
    if (lastTap && now - lastTap.t < DOUBLE_TAP && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30 && lastTap.key === key) {
      lastTap = { touch: true, t: 0 };
      pendingDbl = { x: e.clientX, y: e.clientY, target };
      fallback = setTimeout(fireDbl, 350); // se il clic del secondo tocco non arriva
      return;
    }
    lastTap = { touch: true, t: now, x: e.clientX, y: e.clientY, key };
  }, true);

  // Il doppio clic parte dopo che la pagina ha gestito il clic del secondo tocco, come farebbe il browser
  let pendingDbl = null;
  let fallback = null;
  function fireDbl() {
    clearTimeout(fallback);
    if (!pendingDbl) return;
    const { x, y, target } = pendingDbl;
    pendingDbl = null;
    const el = document.elementFromPoint(x, y) || target;
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }
  window.addEventListener('click', () => { if (pendingDbl) setTimeout(fireDbl, 0); });

  // ---------- Invito a ruotare il telefono ----------
  const phone = matchMedia('(pointer: coarse) and (max-width: 600px) and (orientation: portrait)');
  const canLock = Boolean(document.documentElement.requestFullscreen && screen.orientation?.lock);
  const banner = document.createElement('div');
  banner.id = 'rotate-hint';
  banner.className = 'rotate-hint hidden';
  banner.innerHTML = `<span class="rh-icon" aria-hidden="true">⟳</span>
    <span class="rh-text">Ruota il telefono in orizzontale per vedere meglio il tavolo.${canLock ? '' : '<small>Se non gira, sblocca la rotazione dello schermo.</small>'}</span>
    ${canLock ? '<button type="button" class="primary" data-rh="lock">Orizzontale</button>' : ''}
    <button type="button" data-rh="close" aria-label="Chiudi">✕</button>`;
  document.body.appendChild(banner);

  // L'invito compare una volta sola per dispositivo e sparisce da solo: copre la parte alta del tavolo
  const AUTO_HIDE = 7000;
  let autoHide = null;
  let dismissed = false;
  try { dismissed = localStorage.getItem('ct-rotate-seen') === '1'; } catch {}

  function dismiss() {
    dismissed = true;
    clearTimeout(autoHide);
    try { localStorage.setItem('ct-rotate-seen', '1'); } catch {}
  }

  function inGame() {
    // nella sala d'attesa delle regole automatiche il verticale va benissimo: niente invito
    const auto = !$('#auto').classList.contains('hidden') && !$('#auto .auto-lobby');
    return auto || !$('#game').classList.contains('hidden');
  }
  function update() {
    const show = !dismissed && phone.matches && inGame();
    banner.classList.toggle('hidden', !show);
    if (show && !autoHide) autoHide = setTimeout(() => { dismiss(); update(); }, AUTO_HIDE);
    syncWakeLock();
  }

  // In partita lo schermo resta acceso anche durante i turni altrui. Il blocco cade da solo quando l'app va in secondo piano.
  const WAKE_RETRY = 10000;
  let wakeLock = null;
  let wakePending = false;
  let wakeFailedAt = 0;

  async function syncWakeLock() {
    if (!navigator.wakeLock || !coarsePointer()) return;
    const wanted = () => inGame() && document.visibilityState === 'visible';
    if (!wanted()) {
      const lock = wakeLock;
      wakeLock = null;
      lock?.release().catch(() => {});
      return;
    }
    if (wakeLock || wakePending || Date.now() - wakeFailedAt < WAKE_RETRY) return;
    wakePending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      wakeLock = lock;
      if (!wanted()) syncWakeLock();
    } catch {
      wakeFailedAt = Date.now(); // alcuni browser lo concedono solo dopo un tocco: si riprova al prossimo
    } finally {
      wakePending = false;
    }
  }
  const coarsePointer = () => matchMedia('(pointer: coarse)').matches;
  document.addEventListener('visibilitychange', update);
  document.addEventListener('pointerdown', () => { wakeFailedAt = 0; syncWakeLock(); }, { passive: true });

  banner.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rh]');
    if (!b) return;
    if (b.dataset.rh === 'lock') {
      try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        await screen.orientation.lock('landscape');
      } catch {
        window.CT?.toast('Questo browser non permette di ruotare da qui: gira il telefono.');
      }
    }
    dismiss();
    update();
  });

  // Uscendo dallo schermo intero torna la rotazione libera
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) try { screen.orientation.unlock(); } catch {}
  });

  phone.addEventListener('change', update);
  const watch = new MutationObserver(update);
  for (const s of ['#game', '#auto', '#builder']) watch.observe($(s), { attributes: true, attributeFilter: ['class'] });
  // l'interfaccia delle regole automatiche passa dalla sala alla partita senza cambiare classi
  watch.observe($('#auto'), { childList: true, subtree: true });
  update();
})();
