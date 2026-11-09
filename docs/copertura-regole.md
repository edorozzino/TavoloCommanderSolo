# Copertura delle Comprehensive Rules

Confronto tra il motore (`engine/`) e le regole in vigore dal 6 novembre 2026. Il testo ufficiale non è incluso nel progetto:
qui compaiono solo numeri di regola e riassunti nostri. `node scripts/verifica-citazioni.js <regolamento.txt>` controlla che
i numeri citati nel codice esistano ancora dopo un aggiornamento del regolamento.

**Stato:** ✅ automatica · 🟡 parziale · ❌ mancante

In questa versione non ci sono i comandi manuali: dove compare ✋ l'effetto non viene applicato.

## Priorità, Pila e risoluzione

| Regola | Argomento | Stato | Note |
|---|---|---|---|
| 117.1–117.5 | Chi ha la priorità, azioni di stato prima di riceverla | ✅ | |
| 405 | Pila ultimo-entrato primo-uscito, ordine APNAP | ✅ | |
| 601.2 | Lancio: bersagli, costo totale, pagamento | 🟡 | Mana pagato in automatico; manca la divisione di effetti tra bersagli (601.2d) |
| 602 | Attivare abilità | ✅ | Per le carte programmate |
| 603.2–603.3 | Inneschi sulla Pila in ordine APNAP | ✅ | |
| 603.3b | Ordine scelto tra i propri inneschi simultanei | ❌ | Oggi lo decide il motore |
| 603.4 | Condizione "se" controllata anche alla risoluzione | ❌ | |
| 608.2b | Bersagli ricontrollati alla risoluzione | ✅ | Anche con bersagli solo in parte illegali |
| 608.2n, 608.3 | Fine risoluzione, permanenti sul campo | ✅ | |

## Azioni basate sullo stato (704)

| Regola | Argomento | Stato | Note |
|---|---|---|---|
| 704.5a–d, f–h | Vita, grimorio vuoto, veleno, token, danno letale, tocco letale | ✅ | |
| 704.5j | Regola delle leggende | ✅ | |
| 704.5q | Segnalini +1/+1 e -1/-1 si annullano | ✅ | |
| 704.5i | Planeswalker a fedeltà 0 | ❌ | Fedeltà solo come segnalino manuale ✋ |
| 704.5m–p | Aure e Equipaggiamenti non legalmente assegnati | ❌ | |
| 704.6c | 21 danni da comandante | ✅ | |
| 704.6d | Comandante da cimitero o esilio alla zona di comando | ✅ | |

## Combattimento

| Regola | Argomento | Stato | Note |
|---|---|---|---|
| 508–511 | Attaccanti, bloccanti, danno, Attacco improvviso | ✅ | |
| 510.1c | Divisione libera del danno tra più bloccanti | ❌ | Oggi automatica |

## Effetti continui e sostituzioni

| Regola | Argomento | Stato | Note |
|---|---|---|---|
| 611 | Effetti continui | 🟡 | Signori e +X/+X programmati carta per carta |
| 613 | Sistema dei livelli | ❌ | ✋ per le carte non programmate |
| 614, 616 | Effetti di sostituzione e loro ordine | 🟡 | Solo casi singoli (entrata con segnalini, comandante) |
| 615 | Prevenzione del danno | 🟡 | Solo casi singoli |

## Commander e multiplayer

| Regola | Argomento | Stato | Note |
|---|---|---|---|
| 103.5 | Mulligan | ✅ | Primo gratis in multiplayer (103.5c); non nelle lezioni dell'Accademia |
| 800.4a | Uscita di un giocatore | ✅ | |
| 903.4–903.5 | Identità di colore e costruzione del mazzo | ✅ | |
| 903.8 | Tassa del comandante | ✅ | |
| 903.9a–b | Ritorno alla zona di comando | ✅ | |
| 903.10a | Danni da comandante | ✅ | |
