# Tavolo Commander

Tavolo virtuale per giocare a Magic: The Gathering in formato **Commander** in rete locale
(stile Cockatrice/YGOPro, ma nel browser). Le regole le applicate voi giocatori, come al tavolo vero:
l'app tiene traccia di carte, zone, vita, danni da comandante e informazioni nascoste.

## Versione da telefono, senza server

Oltre al server Node, questo progetto si pubblica come sito statico su **GitHub Pages**: la partita con regole contro il computer
e l'Accademia girano interamente nel telefono (il codice del server è impacchettato in `local-server.js`), i mazzi si salvano
nella memoria del dispositivo e, dopo la prima apertura, funziona anche offline. Il tavolo libero in LAN e gli inviti agli amici
restano possibili solo con il server sul computer.

- `npm run build` prepara la versione in `dist/`; `npm run web` la prova sul computer su http://localhost:8080
- a ogni push su `main` GitHub Actions esegue i test e la pubblica (`.github/workflows/pages.yml`)
- sull'iPhone: apri il sito in **Safari** → Condividi → **Aggiungi alla schermata Home**
- le partite stanno in memoria: se iOS chiude l'app in background, la partita in corso si perde (i mazzi no)

## Avvio

Serve [Node.js](https://nodejs.org) 18 o superiore.

```bash
cd commander-table
npm install      # solo la prima volta
npm start
```

Il terminale mostra due indirizzi:
- `http://localhost:3000` per giocare dal computer che fa da server;
- `http://192.168.x.x:3000` da aprire su PC, tablet o telefoni degli altri giocatori **sulla stessa Wi-Fi**.

Tutti scrivono lo stesso nome del tavolo (di default `tavolo`). Per cambiare porta: `PORT=8080 npm start`.
Se gli altri non riescono a collegarsi, controlla che il firewall permetta la porta 3000
(su Ubuntu: `sudo ufw allow 3000/tcp`).

## Password di accesso

Per chiedere una password a chi apre il tavolo, avvia il server con la variabile `TAVOLO_PASSWORD`:

```bash
TAVOLO_PASSWORD=lamiapassword npm start                    # Linux / macOS
$env:TAVOLO_PASSWORD="lamiapassword"; npm start            # Windows PowerShell
```

Chi apre il sito vede una schermata di accesso; dopo il login il browser resta autorizzato (cookie valido un anno).
Senza password non si vedono pagine, mazzi salvati né partite. Cambiando password, tutti devono rifare il login.

## Giocare da remoto con Tailscale

[Tailscale](https://tailscale.com) collega i PC tuoi e dei tuoi amici in una rete privata: il tavolo non è pubblico su
internet, ha un vero HTTPS (l'app si installa anche sui telefoni) e non serve aprire porte sul router.

Una volta sola:
1. tu e i tuoi amici installate Tailscale ([download](https://tailscale.com/download)) e fate login;
2. dal [pannello di Tailscale](https://login.tailscale.com/admin/machines) condividi il tuo PC con loro
   (menu "…" del PC → *Share*) oppure invitali nella tua rete;
3. su Linux dai al tuo utente il permesso di usare `tailscale serve`: `sudo tailscale set --operator=$USER`.

Poi, per ogni partita:

```bash
TAVOLO_PASSWORD=lamiapassword npm run remote
```

Il server pubblica il tavolo nella rete Tailscale e mostra l'indirizzo da mandare agli amici
(`https://<nome-pc>.<rete>.ts.net`). La prima volta Tailscale può chiedere di attivare *Serve* e HTTPS con un link nel
terminale: aprilo, conferma e il server continua da solo. Con Ctrl+C il tavolo viene tolto da Tailscale.

### Senza far installare niente agli amici (Tailscale Funnel)

```bash
npm run public
```

Il tavolo diventa raggiungibile da internet allo stesso indirizzo, da qualsiasi browser, senza Tailscale sui dispositivi
degli amici. A ogni avvio il server genera una nuova password (tre parole e un numero, per esempio `drago-luna-spada-42`)
e stampa un messaggio pronto da incollare su WhatsApp con il **link di accesso diretto** (`…/login?k=<password>`):
chi lo apre entra senza digitare nulla. Per usare una password fissa: `TAVOLO_PASSWORD=... npm run public`.
La prima volta Tailscale può chiedere di attivare *Funnel* con un link nel terminale.

### Invitare gli amici dal gioco

Al tavolo LAN il pulsante **📨 Invita** in alto, e nella sala d'attesa della partita con regole il riquadro **Invita amici**,
aprono una finestra con il link di quel tavolo: chi lo apre entra direttamente nel tavolo giusto, senza scrivere la password né il
nome del tavolo (deve solo scegliere il proprio nome, e la volta dopo entra da solo). Ci sono il codice QR da inquadrare col telefono
e i pulsanti Condividi, WhatsApp e Copia link. Se il tavolo è pubblicato con Tailscale il link usa quell'indirizzo, altrimenti
quello della rete Wi-Fi; quando ce n'è più d'uno si sceglie in cima alla finestra.

Dopo 20 password sbagliate in 10 minuti il login si blocca per 10 minuti (chi è già entrato continua a giocare).
`TAVOLO_PASSWORD=auto` genera la password a ogni avvio anche con `npm start` e `npm run remote`.

## Partita con regole automatiche

Dal menu principale, **Partita con regole** apre un tavolo in cui il motore applica le regole di Magic: fasi e passi,
priorità, Pila, combattimento, inneschi, azioni basate sullo stato, danni da comandante. Da 2 a 4 giocatori entrano con
lo stesso nome del tavolo, ognuno sceglie un mazzo (i 4 mazzi iniziali, oppure un mazzo salvato se il motore conosce
tutte le sue carte) e chi ha creato il tavolo (★) avvia la partita.

- Clic su una carta in mano: la giochi (terra) o la lanci; se servono bersagli, modalità, sacrifici o scarti, il pannello
  a destra li chiede uno alla volta ed evidenzia sul tavolo le scelte valide. Il mana si paga in automatico con le tue terre.
- Clic su un tuo permanente: le sue abilità (mana o attivate).
- **Passa** (o Spazio) cede la priorità. Come in MTG Arena, quando non hai niente da giocare né abilità da attivare la priorità
  passa da sola, così con gli amici nessuno resta ad aspettare un clic; si disattiva con "Passa da solo quando non posso fare niente".
  Quando un avversario lancia una magia e tu puoi rispondere, il pulsante Passa lampeggia. Durante attacchi, blocchi, scarti, ricerche e profezie il pannello guida la scelta.
- Un'azione non consentita viene rifiutata con il motivo (per esempio "Servono {2}{R}{R}" o "è entrata in questo turno").
- **Contro il computer**: nella sala d'attesa chi ha creato il tavolo può aggiungere da 1 a 3 giocatori computer, ciascuno
  con un mazzo iniziale (scelto o a sorpresa). Si può giocare da soli sul proprio PC, oppure con amici in LAN più qualche
  computer. Il computer è un avversario da principiante: gioca terre e magie, attacca, blocca e usa le rimozioni con regole
  di buon senso, e propone solo mosse che il motore ha già verificato come legali.

Limiti attuali: il danno contro più bloccanti e l'ordine degli inneschi simultanei dello stesso giocatore sono decisi dal
motore; la partita resta in memoria finché il server è acceso.

## Accademia

Dal menu principale, **Accademia** propone 8 lezioni guidate (le carte e le zone, il mana, il turno, il combattimento,
istantanei e Pila, abilità, keyword, il comandante). Ogni lezione è una partita vera contro il Maestro, un avversario che
gioca mosse preparate: il riquadro a destra mostra l'obiettivo e un suggerimento che cambia a ogni passo, e la lezione
si supera (o si riprova) automaticamente. Le lezioni superate restano segnate nel browser.

Nelle partite con regole automatiche e nelle lezioni le carte che puoi usare adesso sono illuminate in verde; le altre
sono scurite e, passando il mouse o cliccandole, spiegano perché non si possono usare.

## Editor dei mazzi

Pulsante **I miei mazzi** (nell'ingresso o in partita), ispirato all'editor di YGOPro:
- **a sinistra** la scheda della carta sotto il mouse: immagine, costo, tipo, testo, legalità in Commander;
- **al centro** il mazzo: zona *Comandante* (fino a 2), *Mazzo* diviso per tipo, *Forse* (carte da valutare),
  totale /100, curva di mana e avvisi (doppioni, carte fuori identità di colore, bandite);
- **a destra** la ricerca su Scryfall: nome, testo o sintassi Scryfall, tipo, sottotipo, colori, costo, rarità, ordine
  (più giocate su EDHREC, nome, costo…), con filtro automatico sull'identità del comandante.

Doppio clic o `+` per aggiungere, 👑 per scegliere il comandante, trascinamento tra risultati e zone,
clic destro per gli altri comandi. In alto: Nuovo, Salva, Salva con nome, Rinomina, Elimina, Importa/Esporta `.txt`,
Mano di prova e *Gioca con questo mazzo*. I mazzi sono salvati sul server in `data/decks.json`,
quindi li vedono tutti i dispositivi collegati.

## App installabile (PWA)

Il Tavolo Commander si può installare come un'app: icona tra le app, finestra senza barre del browser, avvio anche quando
il server è spento (in quel caso compare un avviso; per giocare il server deve essere acceso).

- **Sul computer che fa da server**: apri http://localhost:3000 con Chrome o Edge e usa il pulsante
  **Installa l'app** nel menu principale (oppure l'icona di installazione nella barra degli indirizzi).
- **Su telefoni e tablet in rete locale** i browser permettono l'installazione solo in HTTPS:
  1. sul computer esegui una volta `./scripts/make-cert.sh`: crea in `certs/` un'autorità di certificazione locale
     (`ca.pem`) e il certificato del server; riavvia il server, che parte anche su `https://<IP del computer>:3443`;
  2. copia `certs/ca.pem` sul telefono e installalo come certificato attendibile:
     Android: Impostazioni → Sicurezza → Altre impostazioni → Installa certificato → Certificato CA;
     iPhone: aprilo, installa il profilo, poi Impostazioni → Generali → Info → Impostazioni certificati → abilita l'attendibilità;
  3. apri `https://<IP del computer>:3443` e scegli "Aggiungi a schermata Home" / "Installa app".
  Se l'IP del computer cambia, rilancia lo script. Il firewall deve permettere anche la porta 3443.
  Non condividere `certs/ca-key.pem`: chi la possiede potrebbe creare certificati accettati dai tuoi telefoni.

## Come si gioca

1. **Carica mazzo**: carica il file `.txt` esportato da Moxfield, Archidekt, EDHREC o Arena (pulsante *Carica file .txt*
   oppure trascina il file sulla lista), o incolla la lista (`1 Sol Ring`, nomi in inglese).
   Il comandante viene riconosciuto da solo (sezione `Commander`, segno `*CMDR*`/`[Commander]`, ultimo blocco
   separato da una riga vuota, altrimenti la prima carta) e puoi cambiarlo dai menu *Comandante* e *Secondo comandante*.
   Immagini e dati arrivano da Scryfall e vengono salvati in `data/cards-cache.json`.
2. Pesca 7 carte (`D` sette volte, oppure clic destro sul grimorio → *Pesca N carte*). *Mulligan* è nel menu della mano e del grimorio.
3. Durante il tuo turno usa **Inizia turno** (stappa tutto + pesca) e **Passa turno**.

| Azione | Come |
|---|---|
| Giocare una carta / lanciare il comandante | trascinala sul campo, oppure doppio clic |
| Tappare / stappare | doppio clic sulla carta sul campo |
| Altre azioni (segnalini, trasforma, faccia in giù, sposta, dai il controllo…) | clic destro sulla carta |
| Grimorio (profetizza, cerca, macina, mescola) | clic o clic destro sul grimorio |
| Vedere cimitero / esilio | clic sulla pila (anche degli avversari) |
| Mettere in fondo al grimorio trascinando | tieni premuto Maiusc mentre rilasci |
| Vita ±5 / danni da comandante ±5 | Maiusc + clic sui pulsanti |
| Scorciatoie | `D` pesca · `U` stappa tutto · `T` inizia turno · `P` passa turno · `Esc` chiudi |

Regole Commander già incluse: 40 punti vita, zona di comando, **tassa del comandante** calcolata in automatico
(+2 ogni volta che lo lanci dalla zona di comando), **danni da comandante** separati per ogni comandante avversario
(tolgono anche punti vita; a 21 viene segnalata la sconfitta), segnalini veleno, primo mulligan gratuito,
token che spariscono quando lasciano il campo.

Le partite restano in memoria finché il server è acceso: se lo fermi, la partita si perde (i mazzi incollati restano salvati nel browser).
Se un giocatore ricarica la pagina, rientra automaticamente al suo posto.

## Motore delle regole (in sviluppo, TDD)

La cartella `engine/` contiene il motore delle regole automatiche, sviluppato in Test-Driven Development
secondo la specifica: ogni regola nasce da un test in `test/` che cita il numero della Comprehensive Rules.

```bash
npm test        # test del motore (circa 30 secondi)
npm run fuzz    # 1.000 partite casuali (circa 7 minuti)
```

Coperto finora:
- **Fase 1**: preparazione della partita a 2-4 giocatori, struttura del turno e priorità, mana pool,
  terre, lancio di magie con tempi corretti, Pila LIFO e bersagli, tassa e ritorno del comandante, azioni basate
  sullo stato (vita, veleno, grimorio vuoto, danno letale) ed eliminazione dei giocatori.
- **Fase 2 (in corso)**: combattimento completo (attaccanti verso avversari diversi, bloccanti, passo del danno
  con Attacco improvviso), debolezza da evocazione, keyword Volare, Raggiungere, Cautela, Rapidità, Difensore,
  Minacciare, Travolgere, Tocco letale, Legame vitale, Attacco improvviso, Doppio attacco, Indistruttibile,
  Lampo, Anti-malocchio, danni da comandante (21 dallo stesso comandante) e scarto a 7 carte a fine turno.

- **Abilità**: abilità attivate con {T} e mana (es. Krenko, Rod of Ruin), abilità innescate quando entra, quando
  muore e nel mantenimento, ordine APNAP sulla Pila, token (che spariscono fuori dal campo).

- **Mazzi iniziali**: "Goblin di Krenko" (aggressivo, rosso) con tutte le 68 carte programmate e testate:
  effetti statici dei signori Goblin, +X/+X fino a fine turno, segnalini +1/+1, sacrifici e scarti come costo,
  ricerca nel grimorio, Tesori, mana dell'identità del comandante, riduzioni di costo, abilità innescate con bersaglio.
  Poi "Tempesta di Talrand" (controllo, blu): contromagie, pescate con profetizzare e selezione delle prime carte,
  rimbalzi in mano, creature non bloccabili e volanti, inneschi sul danno da combattimento e sulle pescate avversarie.
  Poi "Ruggito di Ghalta" (rampa, verde): elfi che producono mana, cerca-terre, approdo, signori condizionati
  ("se controlli il tuo comandante"), segnalini, bersagli multipli (Bite Down), inneschi quando lascia il campo.
  Infine "Banchetto di Syr Konrad" (combo, nero), costruito dal mazzo Syr Konrad salvato nell'editor: sacrifici scelti da
  ogni giocatore, prosciugamenti, rianimazione, devozione, Living Death, tutor, inneschi sulle carte creatura che
  vanno nel cimitero o ne escono.
  Si sceglie da "Carica mazzo" in partita oppure si copia tra i propri dall'editor (pulsante "Mazzi iniziali").

Oltre ai test, `npm run fuzz` gioca 1.000 partite con azioni casuali e controlla che il motore non vada mai in errore,
che ogni carta sia sempre in una sola zona e che le azioni rifiutate non modifichino lo stato.

Limiti attuali: il danno di un attaccante bloccato da più creature è assegnato in automatico (letale a ciascuno
nell'ordine di blocco); il motore conosce solo le carte definite in `engine/cards.js`.
Il tavolo manuale resta disponibile per giocare con qualsiasi carta; la "Partita con regole" usa il motore.

## File

- `server.js`: server HTTP + WebSocket, stato della partita, informazioni nascoste per ciascun giocatore
- `scryfall.js`: ricerca di carte e token su Scryfall, con cache
- `engine/`: motore delle regole (TDD)
- `test/`: test automatici del motore (`npm test`)
- `public/`: interfaccia (HTML, CSS, JavaScript, nessuna build), manifest e service worker della PWA
- `scripts/make-cert.sh`: certificato HTTPS per installare l'app sui telefoni

Magic: The Gathering è un marchio di Wizards of the Coast. Questo progetto non è affiliato né approvato da Wizards of the Coast.
I dati e le immagini delle carte sono forniti da [Scryfall](https://scryfall.com).
