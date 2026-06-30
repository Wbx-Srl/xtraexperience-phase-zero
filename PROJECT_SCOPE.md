# XtraWine Experience Platform - Proposta Tecnica

**Data:** 23 Aprile 2026  
**Versione:** 1.4  
**Status:** ⏳ In Scoping (Pronto per Approvazione)

---

## 🧪 FASE ZERO — Market Validation (Prototype)

> **Obiettivo:** validare che il mercato esista — i clienti comprano le experience e le cantine partecipano — prima di costruire la piattaforma completa. Tutto il codice scritto in questa fase è **usa e getta tranne il webhook handler**, che diventa il primo mattone della piattaforma reale.

**Stack Fase Zero:** Shopify Plus (metafield nativi) + Vercel (webhook + lookup function) + Klaviyo (email transazionale via API — già in uso da XtraWine) + Shopify Pages (info cantina)  
**Nessuna app di terze parti a pagamento. Costo infrastruttura: €0.**  
**Tempo totale stimato: 3-4 giorni lavorativi.**

---

### Step 0.1 — Prerequisiti e accessi *(0.5 giorni)*

> **Nota 2026:** Shopify ha eliminato le Legacy Custom Apps dall'Admin del merchant. Dal 1° gennaio 2026 **tutte le app** (anche quelle per un solo merchant) si creano dal **Partner/Dev Dashboard** e richiedono il flusso OAuth 2.0 per ottenere il token. Le app create da Partner Dashboard usano un flow OAuth dedicato: il token ottenuto va **salvato in storage persistente** (Vercel KV), non in env vars statiche — così è rotabile senza rideploy.
> Fase Zero usa una **Custom App** → access token offline (non-expiring finché non viene revocato o reinstallato). Il flow OAuth va implementato correttamente e il token salvato su **Vercel KV**, non hardcoded.

| Task | Dettaglio |
|------|-----------|
| Accesso Partner Dashboard | Accedere a **partners.shopify.com** → App → Crea app |
| Configurare App URL e Redirect URL | App URL: `https://xtrawine-phase-zero.vercel.app` — Redirect URL: `https://xtrawine-phase-zero.vercel.app/api/auth/callback` |
| Definire API Scopes | `read_orders`, `write_orders`, `read_products`, `write_discounts` — i metafield di prodotto sono coperti da `read_products`; i metafield ordine da `write_orders`; `write_discounts` per generare codici sconto cross-selling via Admin API (Discount Codes) |
| Credenziali disponibili | **`SHOPIFY_CLIENT_ID`** e **`SHOPIFY_CLIENT_SECRET`** — visibili nel Partner Dashboard. Il secret serve per: (1) firmare/verificare HMAC dei webhook, (2) scambio codice OAuth → access token |
| Implementare OAuth flow (una tantum) | Endpoint `GET /api/auth` → redirect a Shopify con `client_id + scopes` → Shopify chiama `GET /api/auth/callback?code=...` → scambio `code` con access token via `POST https://{shop}/admin/oauth/access_token` |
| Salvare access token | Salvare `{ shop, access_token, scope, installed_at }` su **Vercel KV** (chiave: `shop:{domain}`) — non come env var statica. Questo permette rotazione senza rideploy e gestione corretta di reinstallazioni. |
| Installazione dal merchant | Inviare il link di installazione generato nel Partner Dashboard al merchant XtraWine → il merchant lo apre, approva gli scope, completa il flusso OAuth |
| Registrazione webhook (programmatica) | Subito dopo aver salvato il token nel callback OAuth: `POST /admin/api/2025-04/webhooks.json` con topic `orders/paid` e address `https://xtrawine-phase-zero.vercel.app/api/order-paid`. **Non registrare manualmente da Admin** — così è versionato, replicabile e self-healing ad ogni reinstallazione. Registrare anche `orders/refunded` e `orders/cancelled` per sicurezza. |
| Account Vercel | Piano free sufficiente (incluso Vercel KV). Progetto: `xtrawine-phase-zero` |
| API key Klaviyo | XtraWine ha già Klaviyo attivo. Generare una **Private API Key** da Klaviyo → Account → API Keys con scope `Events - Write`. Nessun nuovo account, nessuna domain authentication da fare (già configurata). |

---

### Step 0.2 — Configurazione prodotti experience su Shopify *(0.5 giorni)*

Per ogni prodotto experience (es. "Visita Cantina Antinori"):

| Task | Dettaglio |
|------|-----------|
| Product Type | Impostare il campo nativo **Product type** (Admin → Prodotti → [prodotto] → Organizzazione → Tipo prodotto) al valore concordato per le experience (es. `"Experience"`). Il webhook usa `line_item.product_type` — già presente nel payload Shopify — per filtrare i line item **senza chiamate API aggiuntive**. Il valore atteso va configurato nella env var `EXPERIENCE_PRODUCT_TYPE`. Non servono tag dedicati. |
| Metafield `xw_experience.url` | Tipo: `single_line_text_field`. Valore: URL della Shopify Page della cantina (es. `/pages/antinori-experience`). Aggiunto da Admin → Prodotti → [prodotto] → Metafield. |
| Metafield `xw_experience.cantina_name` | Tipo: `single_line_text_field`. Valore: nome cantina leggibile (es. "Marchesi Antinori"). Usato nell'email. |
| Metafield `xw_experience.cantina_email` | Tipo: `single_line_text_field`. Email operativa della cantina. Il webhook invia qui la notifica di vendita. |
| Metafield `xw_experience.instructions` | Tipo: `multi_line_text_field`. Istruzioni per il cliente su come utilizzare il voucher: cosa portare, come prenotare la visita, orari, dove presentarsi. Incluse nell'email voucher inviata al cliente via Klaviyo. |

> **Nota**: usare namespace `xw_experience` (non il generico `app`) per evitare collisioni con altre app installate sul merchant. Questi metafield si creano una sola volta come definizioni in Admin → Contenuto → Metafield → Prodotti, poi appaiono in ogni scheda prodotto.

---

### Step 0.3 — Shopify Pages per le cantine *(0.5 giorni — contenuto)*

Per ogni cantina attiva nel test, creare una Shopify Page (`/pages/[cantina-slug]`) con:

- Come prenotare la visita (telefono / email cantina)
- Orari di apertura e chiusure stagionali
- Cosa include l'experience
- Policy di cancellazione
- Come presentarsi (mostra il codice voucher via email o QR)

Queste pagine sono statiche, nessun codice. Possono essere create dall'ecommerce manager di XtraWine direttamente da Admin.

---

### Step 0.4 — Webhook handler su Vercel *(1 giorno — sviluppo core)*

Repo: `xtrawine-phase-zero` su GitHub. Deploy automatico su Vercel ad ogni push su `main`.

**Endpoint: `POST /api/order-paid`**

Flusso:
```
1. Shopify invia webhook orders/paid
2. Verifica HMAC (X-Shopify-Hmac-Sha256) con timing-safe compare → se invalido → 401
3. Risponde 200 SUBITO (Shopify richiede risposta entro 5s — il processing avviene dopo)
4. Idempotenza: controlla su Vercel KV se chiave "processed:{order_id}" esiste già
   → se esiste → skip (webhook retry di Shopify, non riprocessare)
   → altrimenti → setta chiave con TTL 30gg
5. Legge access_token da Vercel KV (chiave: shop:{domain})
6. Controlla se l'ordine contiene SOLO experience o anche prodotti vino:
     - flag `has_wine = order.line_items.some(i => i.product_type !== EXPERIENCE_PRODUCT_TYPE)`
     (usato al step 10 per splitting email)
7. Loop su order.line_items:
     se line_item.product_type === EXPERIENCE_PRODUCT_TYPE (già nel payload, nessuna chiamata API aggiuntiva):
       a. Verifica idempotenza a livello line_item: chiave "processed:{order_id}:{line_item_id}"
       b. Genera codice: sha256(order_id + line_item_id + VOUCHER_SECRET_SALT)
          → encode Crockford Base32, slice 12 char, formato: XW-XXXX-XXXX (es. XW-7K4P-9M2A)
       c. Legge product metafield xw_experience.url via Admin API
       d. Legge product metafield xw_experience.cantina_name via Admin API
       e. Legge product metafield xw_experience.cantina_email via Admin API
       f. Legge product metafield xw_experience.instructions via Admin API
       g. Genera codice sconto cross-selling via Shopify Admin API:
          POST /admin/api/2025-04/price_rules.json + discount_codes.json
          Regole: 10% solo sui prodotti della stessa cantina (tag `vendor:{cantina_name}`),
          valido 1 volta, non cumulabile, scadenza 30gg, non applicabile a esperienze.
          Il codice sconto (es. ANTINORI-XW-A3K9) viene passato a Klaviyo nell'evento.
8. Costruisce array JSON vouchers:
     [
       {
         "line_item_id": "...",
         "code": "XW-7K4P-9M2A",
         "cantina": "Marchesi Antinori",
         "url_experience": "https://xtrawine.com/pages/antinori-experience",
         "instructions": "Presenta questo voucher all'ingresso. Prenota la tua visita chiamando il numero...",
         "discount_code": "ANTINORI-XW-A3K9",
         "status": "generated",
         "generated_at": "2026-05-13T10:00:00Z",
         "expires_at": "2027-05-13T23:59:59Z"
       }
     ]
9. Salva ogni voucher su Vercel KV:
     - chiave "voucher:{code}" → oggetto voucher completo (source of truth per il lookup cliente)
     - chiave "order:{order_id}" → array [ { line_item_id, code, cantina_name, experience_name, expires_at }, ... ]
       TTL 2 anni — permette all'ERP di ricostruire la corrispondenza line_item_id → codice voucher per ordine
10. Scrive lo stesso array su Order metafield (namespace: xw_experience, key: vouchers, type: json)
     via Admin API — visibile in Admin Shopify E leggibile dall'ERP via Admin API
     (alternativa alla query Vercel se l'ERP parla già con Shopify Admin)
11. Invio email — UNA email Klaviyo PER OGNI voucher (non un'unica email con tutti i voucher):
     IMPORTANTE ritardo PayPal: se order.payment_gateway === 'paypal',
     attendere almeno 30 minuti prima dell'invio (Vercel Cron Job o delayed call)
     per ogni voucher (1 per line_item, inclusi i line_item con quantity > 1 generano N voucher):
       a. Chiama Klaviyo Track API → evento `Voucher Generated` sul profilo del cliente
          → Klaviyo Flow invia 1 email dedicata per quel singolo voucher
       b. Chiama Klaviyo Track API → evento `Voucher Sold` sul profilo dell'email cantina
          → Klaviyo Flow invia la notifica alla cantina
     Se has_wine = true (ordine misto): Shopify invia già la conferma ordine standard per il vino.
     Le nostre email Klaviyo coprono solo i voucher experience — nessuna duplicazione.
```

> **Pattern timeout Vercel:** il webhook risponde `200` immediatamente dopo la verifica HMAC e il check idempotenza (step 2-4). Il processing successivo avviene nello stesso thread ma Shopify non aspetta. Per Fase Zero questo è accettabile; se si verificano timeout su ordini con molti line_item, spostare il processing in una Vercel Background Function.

**Env vars Vercel:**
```
SHOPIFY_STORE_DOMAIN=
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_WEBHOOK_SECRET=
KLAVIYO_API_KEY=             # Private API Key da Klaviyo → Account → API Keys
VOUCHER_SECRET_SALT=         # stringa random 32 char
APP_BASE_URL=                # https://xtrawine-phase-zero.vercel.app
EXPERIENCE_PRODUCT_TYPE=     # Valore del campo "Product type" in Shopify (es. "Experience")
ERP_SHARED_SECRET=           # Token condiviso tra ERP e Vercel per l'endpoint /api/order-vouchers
PAYPAL_DELAY_MINUTES=30      # Minuti di attesa prima dell'invio email su ordini PayPal (anti-frode)
DISCOUNT_VALIDITY_DAYS=30    # Validità codice sconto cross-selling in giorni
# NON serve SHOPIFY_ACCESS_TOKEN in env: il token viene letto da Vercel KV
```

**Registrazione webhook (programmatica nel callback OAuth):**
```js
// /api/auth/callback — eseguito una volta sola all'installazione
await fetch(`https://${shop}/admin/api/2025-04/webhooks.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    webhook: { topic: 'orders/paid', address: `${APP_BASE_URL}/api/order-paid`, format: 'json' }
  })
})
// Registrare anche orders/refunded e orders/cancelled
```

---

### Step 0.5 — Lookup function (pagina info voucher per il cliente) *(0.5 giorni)*

**Endpoint: `GET /api/voucher?code=XW-7K4P-9M2A`**

Flusso:
```
1. Riceve codice come query param
2. Rate limit: max 20 richieste/IP/min (evita enumeration attack)
3. Cerca su Vercel KV → chiave "voucher:{code}"
   (NON su Shopify Admin API — Shopify non supporta query su contenuto di metafield JSON)
4. Se trovato → restituisce JSON { cantina, url_experience, status, expires_at }
5. Se non trovato → 404 { error: "Codice non trovato" }
```

> **Perché Vercel KV e non Shopify:** la Admin API non è un DB queryable per contenuto interno di metafield JSON. Il metafield `xw_experience.vouchers` sull'ordine serve solo per visibilità in Admin Shopify. Il KV è la source of truth per tutti i lookup.

**Pagina frontend `/voucher`** (Next.js o HTML statico su Vercel):
- Input: campo testo per inserire il codice
- Submit → chiama `/api/voucher?code=...`
- Mostra: nome cantina, link alla pagina experience, stato (attivo / scaduto / già usato)
- Bottone: "Vai alla pagina della cantina →"

> Questa pagina è anche il QR di destinazione: il QR nell'email del cliente punta a `https://xtrawine-phase-zero.vercel.app/voucher?code=XW-7K4P-9M2A` con il codice pre-compilato.

---

**Endpoint ERP: `GET /api/order-vouchers?order_id={id}&token={ERP_SHARED_SECRET}`**

Flusso:
```
1. Verifica token (shared secret — non esposto pubblicamente, solo ERP lo conosce)
2. Legge da Vercel KV → chiave "order:{order_id}"
3. Restituisce array:
   [
     {
       "line_item_id": "...",
       "code": "XW-7K4P-9M2A",
       "cantina_name": "Marchesi Antinori",
       "experience_name": "Visita guidata + degustazione",
       "expires_at": "2027-05-13T23:59:59Z",
       "status": "generated"
     }
   ]
4. Se non trovato → 404
```

> **Due vie per l'ERP** — l'associazione `line_item_id → codice voucher` è disponibile in due posti:
> 1. **Vercel KV** via `GET /api/order-vouchers` (query diretta, sempre aggiornata)
> 2. **Shopify Order metafield** `xw_experience.vouchers` — leggibile via Admin API da qualsiasi sistema già integrato con Shopify. Contiene lo stesso array con `line_item_id` per ogni voucher.

---

### Step 0.6 — Configurazione Klaviyo Flows *(0.5 giorni — zero codice, fatto da Luca)*

Vercel non contiene template email: triggera eventi Klaviyo con payload completo, poi Luca configura i Flow in Klaviyo usando i template già brandizzati XtraWine.

**Evento 1: `Voucher Generated` (al cliente)**

Vercel chiama:
```
POST https://a.klaviyo.com/api/events/
Authorization: Klaviyo-API-Key {KLAVIYO_API_KEY}
Content-Type: application/json

{
  "data": {
    "type": "event",
    "attributes": {
      "metric": { "data": { "type": "metric", "attributes": { "name": "Voucher Generated" } } },
      "profile": { "data": { "type": "profile", "attributes": { "email": "{customer_email}" } } },
      "properties": {
        "code": "XW-7K4P-9M2A",
        "cantina_name": "Marchesi Antinori",
        "experience_name": "Visita guidata + degustazione",
        "url_experience": "https://xtrawine.com/pages/antinori-experience",
        "expires_at": "2027-05-13T23:59:59Z",
        "qr_url": "https://xtrawine-phase-zero.vercel.app/voucher?code=XW-7K4P-9M2A",
        "order_number": "#1042",
        "instructions": "Presenta questo voucher all'ingresso. Prenota la tua visita chiamando il numero...",
        "discount_code": "ANTINORI-XW-A3K9",
        "discount_description": "10% sui vini Marchesi Antinori — valido 30 giorni, una sola volta"
      }
    }
  }
}
```

Klaviyo Flow da creare: trigger `Voucher Generated` → **1 email per evento** (ogni voucher triggera un evento separato). Le variabili disponibili nel template: `{{ event.code }}`, `{{ event.qr_url }}`, `{{ event.instructions }}`, `{{ event.discount_code }}`, `{{ event.discount_description }}`.

> **Nota PayPal:** il Flow Klaviyo deve avere un **ritardo di 30 minuti** sull'azione email quando `{{ event.payment_gateway }} == 'paypal'`. In alternativa il webhook su Vercel ritarda l'invio dell'evento Klaviyo di 30 min per ordini PayPal (Vercel Cron o setTimeout non bloccante).

**Evento 2: `Voucher Sold` (alla cantina)**

Stessa struttura, profile email = `xw_experience.cantina_email`, properties:
```json
{
  "code": "XW-7K4P-9M2A",
  "customer_name": "Mario Rossi",
  "customer_email": "mario@example.com",
  "experience_name": "Visita guidata + degustazione",
  "order_number": "#1042",
  "expires_at": "2027-05-13T23:59:59Z"
}
```

Klaviyo Flow da creare: trigger `Voucher Sold` → email notifica alla cantina.

> **Vantaggio:** deliverability già ottimale (dominio xtrawine.com autenticato in Klaviyo), template gestiti da Luca senza deploy, analytics email già nel pannello Klaviyo esistente.

---

### Step 0.7 — Test e go-live *(0.5 giorni)*

| Test | Come |
|------|------|
| Ordine test con prodotto experience | Shopify dev store o ordine reale con metodo pagamento test |
| Webhook ricevuto e processato | Log Vercel → Functions → order-paid |
| Metafield scritto correttamente | Admin → Ordini → [ordine] → Metafield → xw_experience.vouchers |
| Evento `Voucher Generated` ricevuto da Klaviyo | Klaviyo → Analytics → Events → cerca `Voucher Generated` |
| 1 email per voucher (non 1 email con tutti i voucher) | Acquisto con qty=2: verificare che arrivino 2 email separate |
| Email cliente inviata dal Flow Klaviyo con codice, QR e codice sconto cross-selling | Inbox test |
| Evento `Voucher Sold` ricevuto da Klaviyo | Klaviyo → Analytics → Events → cerca `Voucher Sold` |
| Email cantina inviata dal Flow Klaviyo | Inbox cantina test |
| Ritardo PayPal: email non arriva prima di 30 min su ordine PayPal | Simulare con gateway PayPal in test mode |
| Ordine misto (vino + experience): solo email voucher da Klaviyo, nessuna duplicazione della conferma ordine Shopify | Inbox test ordine misto |
| Codice sconto cross-selling generato su Shopify e usabile | Applicare il codice sconto nel checkout — verifica che sia mono-uso e limitato alla cantina |
| Lookup funziona con il codice corretto | `GET /api/voucher?code=XW-...` |
| Pagina `/voucher` mostra info corrette | Browser |
| QR nell'email apre la pagina con codice pre-compilato | Scan da mobile |

---

### Cosa NON è in Fase Zero (e perché)

| Feature | Perché esclusa |
|---------|---------------|
| Dashboard cantina con login | È la piattaforma vera — va costruita se il test è positivo |
| Stato `booked` / prenotazioni | Fase Zero: la cantina gestisce le prenotazioni telefonicamente |
| Riscatto digitale | Fase Zero: la cantina conferma il riscatto scrivendo a XtraWine |
| Recesso 14gg automatizzato | Gestione manuale via email customer care |
| Export XML/CSV | Non necessario per il test |
| GDPR webhooks | Implementare i 3 handler minimi (`customers/data_request`, `customers/redact`, `shop/redact`) anche in Fase Zero: l'app tratta PII (email, nome cliente) da ordini Shopify e il fatto che sia un test non esonera dall'obbligo. Sono ~50 righe di codice. |
| Landing page esperienze con filtri | Sprint 1 — filtri per regione, tipologia, prezzo, lingue, durata, servizi |
| Mega menu "Esperienze" | Sprint 1 — dipende da volume e categorizzazione cantine |
| Scheda prodotto experience strutturata | Sprint 1 — calendar slot, guide, food&beverage, accessibilità |
| Riepilogo mensile cantina (voucher emessi/riscattati/fatturati) | Sprint 1 — job mensile automatico via Klaviyo |
| Codice voucher in "I miei ordini" Shopify | Sprint 1 — Shopify Customer Account Extension |
| Disabilitare contrassegno/bonifico/ritiro su ordini experience | Sprint 1 — Shopify Functions (non gestibile da Vercel) |
| Post-visita: email cross-sell prodotti cantina | Sprint 2 — da definire trigger e contenuto |

---

### Output atteso da Fase Zero

Al termine delle 3-4 settimane di test sul mercato reale:

- **Quante experience sono state vendute?**
- **Quanti voucher sono stati effettivamente riscattati?**
- **Le cantine hanno risposto alle prenotazioni dei clienti?**
- **Ci sono stati problemi operativi ricorrenti?**

Se i numeri sono positivi → si costruisce la piattaforma completa (Sprint 1-3 del documento).  
Se i numeri non giustificano l'investimento → si è speso 3-4 giorni, non 6-7 settimane.

---

> **Nota strategica (v1.2):** il progetto nasce come soluzione custom per un singolo merchant Shopify Plus (XtraWine), ma è progettato **multi-tenant e vertical-agnostic fin dal giorno 1** per poter essere pubblicato come **Shopify Public App** sul App Store senza rework.
> 
> **Principio guida:** *Shopify è la source of truth.* La nostra app **non duplica** entità che esistono già nel catalogo del merchant (produttori, vendor, collection). Le legge via API e mantiene solo i dati che Shopify non ha (es. email staff per magic link, note operative).
> 
> **Terminologia generica:** internamente il dominio parla di **Partner** (chi eroga l'esperienza fisicamente) e **Experience** (cosa viene riscattato). Il termine "Cantina" è un semplice **label override** applicabile per-merchant. Questo rende l'app utilizzabile anche da birrifici, caseifici, hotel, showroom moda, cooking school, ecc.

---

## 📋 Executive Summary

Implementare un sistema proprietario di **voucher digitali** per trasformare i prodotti "experience" (visite, degustazioni, tour, esperienze) in proposte upsell integrate nella piattaforma Shopify Plus.

**Caso d'uso XtraWine:** cliente compra un vino → può aggiungere una visita presso la **cantina produttrice** di quel vino → riceve voucher → si presenta in cantina per il riscatto.

**Beneficio principale:** Aumenta AOV permettendo ai clienti di aggiungere esperienze immersive all'acquisto, generando nuovi flussi di revenue dai Partner del merchant (cantine, nel caso XtraWine).

**Beneficio secondario:** stesso codebase riusabile come **Shopify App pubblica** monetizzabile via Shopify Billing API, per qualsiasi merchant che abbia prodotti + esperienze abbinabili.

---

## 🧩 Modello di Dominio

| Concetto generico (app/DB) | Label default App Store | Override XtraWine | Cos'è |
|---|---|---|---|
| **Partner** | Partner | Cantina | Chi eroga l'esperienza fisicamente. **Esiste già su Shopify del merchant** (come `product.vendor`, Collection, Metaobject o Tag). La nostra app NON lo crea. |
| **Experience** | Experience | Esperienza | Prodotto Shopify marcato come "experience" dal merchant (visita, degustazione, tour, tasting, cooking class…). |
| **Voucher** | Voucher | Voucher | Codice univoco generato all'acquisto, riscattabile dallo staff del Partner. |
| **Redemption Location** | Location | Cantina | Luogo fisico dove si riscatta (coincide di solito col Partner). |

### Partner Mapping Mode (configurato dal merchant, one-time)

Alla prima installazione il merchant dichiara **come rappresenta i suoi partner su Shopify**. L'app supporta 4 modalità:

| Mode | Sorgente Shopify | Esempio |
|------|------------------|---------|
| `vendor` | Campo standard `product.vendor` | XtraWine se ogni vino ha come vendor il nome della cantina |
| `collection` | Una Collection = un Partner | Merchant con collection "Cantina Pippo Rossi" |
| `metaobject` | Shopify Metaobject custom | Merchant avanzati con schema già definito |
| `tag` | Tag prodotto con prefisso (es. `partner:pippo-rossi`) | Merchant che non vogliono toccare vendor/collection |

**Nessun onboarding manuale dei partner.** Appena il merchant pubblica un prodotto nuovo su Shopify con il mapping corretto, il partner appare automaticamente nella nostra app (auto-discovery via Admin API, cache 5 min).

---

## 🎯 Obiettivi

1. **Generare voucher unici** al momento dell'acquisto di un prodotto "experience"
2. **Distribuire voucher via email transazionale** (SendGrid) con QR code + link testuale di fallback
3. **Permettere ridistribuzione** dal profilo Shopify cliente (resend Email) con rate limit
4. **Portale Partner** per validare/riscattare voucher in-person (login passwordless via magic link)
5. **Visibility experience** nella PDP tramite **Theme App Extension** (no hack al tema del merchant)
6. **Invalidazione automatica voucher** su refund/cancellation (Sprint 1, non optional)
7. **Integrazione ERP** (XtraWine/partner) per tracciamento payouts
8. **Compliance**: GDPR mandatory webhooks + privacy by design (multi-tenant ready)
9. **Zero duplicazione dati Shopify**: i Partner vengono letti da Shopify (vendor/collection/metaobject/tag), non ricreati
10. **Diritto di recesso 14gg** (art. 52 Codice Consumo / Dir. 2011/83/UE): gestione nativa per voucher open-dated, con deadline tracciata e self-service nel Customer Account

---

## 📐 Architettura Alta Livello

```
┌─────────────────────────────────────────────────────────┐
│              SHOPIFY (SOURCE OF TRUTH)                  │
│        (1 merchant oggi, N merchant domani)             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Partner = già presenti nel catalogo Shopify            │
│    (vendor | collection | metaobject | tag)             │
│  L'app li LEGGE, non li crea.                           │
│                                                         │
│  1️⃣  Customer acquista:                                │
│      - Prodotto fisico (es. Barolo 2015)                │
│      - Experience (es. Visita Cantina Pippo)            │
│                                                         │
│  Product metafield (namespace: app, access: PRIVATE):   │
│    - is_experience        = true                        │
│    - partner_key           = "pippo-rossi"              │
│    - validity_days         = 365                        │
│    - experience_type_key   = "visita"                   │
│                                                         │
│  2️⃣  Webhooks: orders/paid, orders/refunded,           │
│      orders/cancelled, app/uninstalled,                 │
│      customers/data_request, customers/redact,          │
│      shop/redact (GDPR)                                 │
│                                                         │
└──────────────┬──────────────────────────────────────────┘
               │
               ↓
┌─────────────────────────────────────────────────────────┐
│      APP (Node.js + TypeScript, Shopify App CLI)       │
│  (multi-tenant, vertical-agnostic, embedded-ready)     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  3️⃣  Webhook Handlers (HMAC + idempotenza)             │
│                                                         │
│  4️⃣  Partner Sync Service                              │
│      ├─ Auto-discovery dal catalogo Shopify             │
│      ├─ Normalizza: vendor|collection|metaobject|tag    │
│      └─ Cache Redis (TTL 5 min)                         │
│                                                         │
│  5️⃣  API Endpoints (tenant-scoped by shop_id)          │
│      ├─ /voucher/:code (pubblico - info only)           │
│      ├─ /partner/dashboard (magic link auth)            │
│      ├─ /partner/:key/redeem (atomic UPDATE)            │
│      ├─ /customer/resend-email                          │
│      └─ /admin (embedded Admin UI - App Bridge)         │
│                                                         │
│  6️⃣  Email Transazionale (SendGrid)                    │
│      ├─ Voucher delivery + QR (Cloudinary signed URL)   │
│      ├─ Magic link staff del Partner                    │
│      └─ Template con {{partner_label}} parametrizzato   │
│                                                         │
└──────────────┬──────────────────────────────────────────┘
               │
               ├─────────────────┬───────────────┬──────────┐
               ↓                 ↓               ↓          ↓
        ┌──────────────┐  ┌──────────────┐  ┌────────┐  ┌──────────┐
        │ PostgreSQL   │  │  Shopify     │  │SendGrid│  │ ERP      │
        │ (dati NOSTRI │  │ (Partner +   │  │(email) │  │ (queue)  │
        │ voucher,     │  │ catalogo +   │  │        │  │          │
        │ staff,       │  │ metafield    │  │        │  │          │
        │ audit)       │  │ privati)     │  │        │  │          │
        └──────────────┘  └──────────────┘  └────────┘  └──────────┘

┌─────────────────────────────────────────────────────────┐
│      PARTNER DASHBOARD (Next.js, esterna)               │
│  dashboard.<app>.com — staff del Partner, non merchant  │
│  Label dinamica: "Cantina" per XtraWine, "Birrificio"   │
│  per un cliente beer, "Struttura" per un hotel, ecc.    │
├─────────────────────────────────────────────────────────┤
│  7️⃣  Login magic link (token hashato, TTL 1h)          │
│      ├─ Lista voucher del proprio partner_key           │
│      ├─ Redeem (scan QR via webcam / input manuale)     │
│      ├─ Report giornaliero/mensile                      │
│      └─ Session revocabile dal merchant Admin           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  MERCHANT ADMIN UI (embedded in Shopify Admin)          │
│  App Bridge + Polaris (iframe dentro admin.shopify.com) │
├─────────────────────────────────────────────────────────┤
│  Step 1: scegli come i tuoi Partner sono su Shopify     │
│          (vendor | collection | metaobject | tag)       │
│  Step 2: lista Partner AUTO-RILEVATI                    │
│          → per ognuno: email staff + validity + on/off  │
│  Step 3: marca prodotti experience (toggle UI)          │
│  Step 4: label personalizzata (es. "Cantina",           │
│          "Birrificio", "Struttura")                     │
│  Step 5: billing (Shopify AppSubscription API)          │
│  + Stato voucher / export CSV / gestione dispute        │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  SHOPIFY PDP WIDGET — Theme App Extension (App Block)  │
├─────────────────────────────────────────────────────────┤
│  8️⃣  Block "Experience Upsell" drag&drop nel tema:     │
│      Se prodotto appartiene a Partner X                 │
│      (derivato da vendor/collection/metaobject/tag)     │
│      AND esiste ≥1 experience per quel Partner          │
│      → box con {{partner_label}} custom                 │
│        (es. "🎫 Visita la Cantina" / "🍺 Visita il       │
│         Birrificio" / "🛏️ Soggiorna con noi")            │
│      → link al product experience                       │
└─────────────────────────────────────────────────────────┘
```

---

## 📊 Componenti Principali

### 1. **Webhook Handlers**

Tutti i webhook condividono lo stesso middleware: HMAC validation + idempotenza via `webhook_events(shopify_webhook_id UNIQUE)` + response 200 OK entro 5s (lavoro pesante in queue).

| Topic | Azione |
|-------|--------|
| `orders/paid` | Per ogni line item experience → genera N voucher → enqueue email |
| `orders/refunded` | Invalida voucher non ancora riscattati → status `refunded` |
| `orders/cancelled` | Invalida voucher → status `cancelled` |
| `app/uninstalled` | Soft-delete dati tenant (retention 30gg poi purge) |
| `customers/data_request` | Export PII del cliente (GDPR obbligatorio) |
| `customers/redact` | Anonimizza PII cliente (GDPR obbligatorio) |
| `shop/redact` | Purge completo dati shop dopo 48h dall'uninstall (GDPR) |

### 2. **Generazione Voucher**
- Algoritmo: Crockford Base32 (12 char), esclude I/L/O/U
- Esempio: `ABCD2N5KG7X8`
- `UNIQUE(code)` a DB + retry su collisione (probabilità trascurabile)
- QR code generato on-demand tramite Cloudinary (signed URL con expiry) — no binari embedded in email

### 3. **Email #2 (Voucher Delivery) — SendGrid**
- Provider: **SendGrid** (no Shopify Email): controllo template, deliverability, analytics
- Template versionati in repo (`backend/src/emails/*.hbs`)
- Contenuto: saluto cliente, lista voucher, QR code (URL Cloudinary), codice testuale, link resend, istruzioni per il riscatto presso il Partner
- Fallback: se SendGrid fallisce → retry 3x con backoff → DLQ + alert

### 4. **Voucher Info Page** (`/voucher/:code`) — OPZIONALE MVP
- Landing page pubblica (no auth)
- Mostra: nome experience, data scadenza, partner location
- **NO dati cliente, NO bottone redeem** (il redeem lo fa solo staff del Partner)
- Rate-limited per evitare enumeration attack sui codici

### 5. **Partner Dashboard** (dashboard.<app>.com)
- **Autenticazione:** Magic Link email (token 32 char random, hashato, single-use, TTL 1h)
- JWT session 24h, revocabile dal merchant
- Tenant-scoped: lo staff vede **solo** i voucher del proprio `shopify_partner_key`
- Label UI **dinamica** via `shops.partner_label`: XtraWine vede "Cantina", un birrificio "Birrificio", un hotel "Struttura", ecc.
- **Redeem Flow (atomic):**
  ```sql
  UPDATE vouchers
  SET status='redeemed', redeemed_at=NOW(), redeemed_by=$user_id
  WHERE code=$code AND status='generated' AND expires_at > NOW()
  RETURNING *;
  ```
  Se `rowCount = 0` → errore specifico (già riscattato / scaduto / inesistente)

### 6. **Merchant Admin UI** (embedded Shopify Admin)
- Framework: **Next.js + Shopify Polaris + App Bridge**
- Autenticazione: session token Shopify (no password custom)
- Sezioni:
  1. **Setup**: scelta `partner_mapping_mode` (vendor/collection/metaobject/tag) e `partner_label`
  2. **Partner auto-rilevati**: lista derivata dal catalogo Shopify, per ognuno email staff + validity + on/off
  3. **Experience**: toggle "is_experience" sui prodotti + tipologia
  4. **Voucher**: stato, filtri, export CSV, dispute
  5. **Billing** (versione App Store): AppSubscription
- **Nessuna UI "Crea Partner"**: i Partner non sono mai creati a mano, vengono scoperti da Shopify.

### 7. **Partner Sync Service**
- Job periodico (cron 5 min) + trigger on-demand da Admin UI
- Legge il catalogo Shopify e normalizza i Partner in base al `partner_mapping_mode`:
  - `vendor` → `DISTINCT product.vendor`
  - `collection` → tutte le collection attive
  - `metaobject` → istanze del metaobject configurato
  - `tag` → tutti i tag con prefisso configurato
- Upsert in `partners` (proiezione cache) con `last_synced_at`
- Cache Redis (TTL 5 min) sui risultati normalizzati per ridurre rate limit Shopify

### 8. **Customer Resend Email** (Shopify Customer Account)
- Link nel profilo Shopify → chiama endpoint backend
- Rate limit: max 1 resend/ora/voucher
- Usa SendGrid (stesso template, stesso codice voucher)

### 9. **PDP Enhancement — Theme App Extension**
- Deliverato come **App Block** (Online Store 2.0): il merchant lo trascina nel tema da theme editor
- Il block risolve il `partner_key` del prodotto corrente in base al `partner_mapping_mode` del merchant
- Fetch a `/api/public/experience-for-partner/:partnerKey` (cached Vercel edge, TTL 60s)
- Il testo del CTA usa il `partner_label` del merchant (es. "Visita la Cantina", "Visita il Birrificio")

### 10. **Database (PostgreSQL) — multi-tenant by design**

```sql
-- TENANT (1 riga oggi, N domani quando diventa App Store)
shops (
  id BIGSERIAL PRIMARY KEY,
  shop_domain TEXT UNIQUE NOT NULL,          -- es. xtrawine.myshopify.com
  access_token TEXT NOT NULL,                -- OAuth token (cifrato at rest)
  scopes TEXT[],
  installed_at TIMESTAMPTZ,
  uninstalled_at TIMESTAMPTZ,
  plan TEXT DEFAULT 'custom',                -- 'custom' | 'free' | 'pro' | 'enterprise'
  -- Configurazione per-merchant
  partner_mapping_mode TEXT NOT NULL
    CHECK (partner_mapping_mode IN ('vendor','collection','metaobject','tag'))
    DEFAULT 'vendor',
  partner_mapping_config JSONB DEFAULT '{}', -- es. { "tag_prefix": "partner:" }
  partner_label TEXT DEFAULT 'Partner',      -- UI label: "Cantina" per XtraWine, "Birrificio", ecc.
  partner_label_plural TEXT DEFAULT 'Partners',
  settings JSONB DEFAULT '{}'
)

-- PARTNER: proiezione cache di entità che vivono su Shopify
-- (vendor / collection / metaobject / tag). NON duplichiamo nome/descrizione:
-- quelli vengono letti live da Shopify API. Qui solo dati NOSTRI.
partners (
  id BIGSERIAL PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  shopify_partner_key TEXT NOT NULL,         -- vendor name | collection handle | metaobject id | tag value
  staff_email TEXT,                          -- destinatario magic link
  operational_notes TEXT,
  is_active BOOLEAN DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shop_id, shopify_partner_key)
)
CREATE INDEX ON partners(shop_id);

-- Prodotti experience (marcati via metafield, cached qui per performance)
experience_products (
  id BIGSERIAL PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  shopify_product_id TEXT NOT NULL,
  shopify_partner_key TEXT,                  -- chiave logica, NON FK dura
  validity_days INT DEFAULT 365,
  experience_type_key TEXT,                  -- 'visita' | 'degustazione' | 'tour' | custom per merchant
  withdrawal_applicable BOOLEAN DEFAULT TRUE, -- FALSE per esperienze a data fissa (art. 59 Cod.Consumo)
  withdrawal_days INT DEFAULT 14,             -- finestra di recesso (default legale EU)
  booking_required BOOLEAN DEFAULT TRUE,      -- se TRUE il cliente DEVE prenotare prima del riscatto
  reminder_hours_before INT DEFAULT 24,       -- email reminder pre-visita (NULL = disabilitato)
  unit_price_cents INT,                       -- prezzo unitario cached (per export contabile / forecast)
  currency CHAR(3) DEFAULT 'EUR',
  UNIQUE(shop_id, shopify_product_id)
)
CREATE INDEX ON experience_products(shop_id, shopify_partner_key);

-- Tipologie di experience configurabili per merchant
experience_types (
  id BIGSERIAL PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  key TEXT NOT NULL,                         -- 'visita' (XtraWine) | 'brewery-tour' (beer) | 'spa-day' (hotel)
  label TEXT NOT NULL,
  UNIQUE(shop_id, key)
)

-- Voucher (collegati al partner tramite CHIAVE, non FK dura a partners)
vouchers (
  id BIGSERIAL PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  order_id TEXT NOT NULL,
  order_number TEXT,                         -- numero d'ordine umano (#1042) per export contabile
  experience_product_id BIGINT REFERENCES experience_products(id),
  shopify_partner_key TEXT NOT NULL,         -- resiliente a rename/delete del partner
  customer_email TEXT,                       -- cifrato a livello app
  customer_name TEXT,                        -- cifrato a livello app (per check ID al Partner)
  status TEXT CHECK (status IN ('generated','booked','redeemed','refunded','cancelled','withdrawn','expired','no_show')),
  expires_at TIMESTAMPTZ NOT NULL,
  withdrawal_deadline_at TIMESTAMPTZ,        -- NULL = recesso non applicabile (booking a data fissa); altrimenti = created_at + 14gg
  withdrawal_requested_at TIMESTAMPTZ,       -- timestamp richiesta cliente (audit legale)
  -- Booking (gestito dal Partner)
  booked_at TIMESTAMPTZ,                     -- quando è stata fatta la prenotazione
  booked_for_at TIMESTAMPTZ,                 -- data/ora visita prenotata
  booked_party_size INT,                     -- numero persone
  booked_notes TEXT,                         -- es. allergie, richieste particolari
  booked_by BIGINT REFERENCES partner_users(id),
  reminder_sent_at TIMESTAMPTZ,              -- per evitare doppio invio
  redeemed_at TIMESTAMPTZ,
  redeemed_by BIGINT REFERENCES partner_users(id),
  amount_cents INT,                          -- snapshot del prezzo all'acquisto (audit contabile)
  currency CHAR(3) DEFAULT 'EUR',
  created_at TIMESTAMPTZ DEFAULT NOW()
)
CREATE INDEX ON vouchers(shop_id, status);
CREATE INDEX ON vouchers(shop_id, shopify_partner_key, status);
CREATE INDEX ON vouchers(shop_id, shopify_partner_key, booked_for_at);  -- calendario Partner
CREATE INDEX ON vouchers(order_id);

-- Staff del Partner (collegato via chiave logica, non FK dura)
partner_users (
  id BIGSERIAL PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  shopify_partner_key TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'operator',
  revoked_at TIMESTAMPTZ,
  UNIQUE(shop_id, shopify_partner_key, email)
)
CREATE INDEX ON partner_users(shop_id, shopify_partner_key);

-- Magic link
auth_tokens (
  id BIGSERIAL PRIMARY KEY,
  partner_user_id BIGINT REFERENCES partner_users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,           -- hash, non plaintext
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
)

-- Audit
voucher_events (
  id BIGSERIAL PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  voucher_id BIGINT REFERENCES vouchers(id),
  event_type TEXT,
  actor TEXT,
  ip INET,
  user_agent TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB
)

-- Idempotenza
webhook_events (
  id BIGSERIAL PRIMARY KEY,
  shop_id BIGINT,
  shopify_webhook_id TEXT UNIQUE NOT NULL,
  topic TEXT,
  status TEXT,
  payload JSONB,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```

**Row-Level Security (RLS):** abilitata dal giorno 1 su tutte le tabelle tenant-scoped; policy `USING (shop_id = current_setting('app.current_shop_id')::bigint)`. Oggi trasparente, domani è il meccanismo di isolamento tra merchant.

---

## 🔐 Sicurezza

| Aspetto | Misura |
|---------|--------|
| **Webhook HMAC** | Valida `X-Shopify-Hmac-SHA256` su ogni richiesta (timing-safe compare) |
| **Idempotenza** | `webhook_events.shopify_webhook_id UNIQUE` |
| **Race condition redeem** | `UPDATE ... WHERE status='generated'` atomico, check `rowCount` |
| **Magic link** | Token random 32B, **hashato** in DB, TTL 1h, single-use |
| **Rate limiting** | Redeem: 10/IP/min. Resend: 1/voucher/h. Voucher info page: 30/IP/min |
| **Audit trail** | Ogni azione loggata (chi, quando, IP, UA) |
| **Metafield ordine voucher** | `access.admin = MERCHANT_READ`, `access.storefront = NONE` (mai esposti al frontend) |
| **Access token Shopify** | Cifrato at rest (AES-256-GCM, key in secret manager) |
| **PII** | Email cliente cifrata a livello app, redatta nei log |
| **CSP / CORS** | Allow-list: Shopify Admin, partner dashboard, Shopify CDN |
| **Tenant isolation** | RLS Postgres su `shop_id` + check applicativo ridondante + isolamento per `shopify_partner_key` nella dashboard Partner |
| **Partner key enumeration** | Lo staff autenticato può leggere solo voucher del proprio `shopify_partner_key` (enforced da RLS + query) |
| **QR cliente ≠ login staff** | Il QR nell'email cliente punta a `voucher.<app>.com/v/{code}` (pagina pubblica read-only). La dashboard staff vive su dominio separato `dashboard.<app>.com` e richiede magic link. Nessun rischio che lo scan del QR dia accesso a dati di altri voucher/Partner. |
| **JWT sessione staff** | Firmato HS256, contiene `{shop_id, partner_user_id, shopify_partner_key}`, TTL 8h sliding. Ogni endpoint dashboard valida e usa questi claim per filtrare le query — mai parametri da URL/body per identificare il Partner. |
| **Doppio check su redeem/book** | UPDATE atomico con `WHERE shopify_partner_key = $session.partner_key AND shop_id = $session.shop_id` — staff Antinori non può prenotare/riscattare voucher di Frescobaldi anche manipolando il client. |
| **Export voucher** | Query forzata sul `partner_key` di sessione + RLS. Audit di ogni export con hash file. URL download firmato TTL 1h single-use. |

---

## 📈 Flussi Principali

### Flusso A: Cliente Compra Experience
```
1. Cliente aggiunge "Visita Cantina Pippo" al carrello
2. Paga tramite Shopify checkout
3. Webhook orders/paid → App (HMAC validato, idempotent)
4. App genera N voucher (N = line_item.quantity)
5. Private metafield ordine aggiornato con JSON { voucher_ids: [...] }
   (codici NON esposti — solo ID interni)
6. Enqueue job "send-voucher-email" → SendGrid
7. Enqueue job "notify-erp" → ERP queue
```

### Flusso B: Redeem presso il Partner
```
1. Cliente arriva presso il Partner con QR (email) o codice testuale
2. Staff apre dashboard.<app>.com (già loggato o magic link)
3. Staff scansiona QR via webcam O digita codice
4. POST /api/partner/:partner_key/redeem  { code }
5. UPDATE atomico: status IN ('generated','booked') → 'redeemed'
   (con AND shopify_partner_key = session.partner_key → no cross-partner redeem)
6. Se rowCount=0 → errore specifico (scaduto/riscattato/invalido/altro partner)
7. Se rowCount=1 → UI mostra "✅ [Experience] - RISCATTATO"
   (testo UI usa {{partner_label}}, es. "Cantina" per XtraWine)
8. Audit event registrato (chi, IP, UA, timestamp)
9. Enqueue notify-ERP
```

### Flusso B-bis: Prenotazione presso il Partner (es. cliente chiama Antinori)
```
Context:
  - Voucher è open-dated. Il cliente, dopo l'acquisto, contatta il Partner
    per fissare data/ora della visita.
  - Solo lo staff del Partner può marcare un voucher come 'booked'.
  - Stato 'booked' è visibile al merchant (XtraWine) per forecast revenue
    e al Partner per pianificazione operativa (calendario, party size totale).

1. Cliente chiama/scrive ad Antinori → fornisce codice voucher o email d'acquisto
2. Staff Antinori (già loggato in dashboard.<app>.com):
     - Cerca voucher per codice o customer_email
     - Click "Prenota" → form: data, ora, party_size, note
3. POST /api/partner/vouchers/:code/book
     { booked_for_at, party_size, notes }
4. UPDATE atomico:
     UPDATE vouchers
       SET status='booked',
           booked_at=NOW(),
           booked_for_at=$1,
           booked_party_size=$2,
           booked_notes=$3,
           booked_by=$session.partner_user_id
     WHERE code=$4
       AND shopify_partner_key=$session.partner_key   -- isolamento Partner
       AND shop_id=$session.shop_id                   -- isolamento merchant
       AND status IN ('generated','booked')           -- riprenotazione consentita
       AND NOW() < expires_at
     RETURNING id;
5. Se rowCount=0 → errore (scaduto / riscattato / wrong partner / non esistente)
6. Email conferma cliente (booking-confirmation.hbs) con dettagli + ICS allegato
7. Schedule reminder T-{reminder_hours_before} → BullMQ delayed job
8. Audit event 'booked'

Transizioni di stato consentite (state machine):
  generated → booked        (staff Partner prenota)
  generated → redeemed      (riscatto walk-in, raro)
  booked    → redeemed      (riscatto giorno della visita)
  booked    → generated     (cancellazione prenotazione, voucher torna disponibile)
  booked    → no_show       (cron post-visita: data passata + non riscattato)
  generated/booked → withdrawn  (recesso 14gg, solo cliente)
  generated/booked → refunded   (refund merchant)
  generated/booked → expired    (cron: NOW() > expires_at)
```

### Flusso C: Cliente Richiede Resend Email
```
1. Cliente accede profilo Shopify Customer Account
2. Storico ordini → voucher attivo → "Reinvia email"
3. Call POST /api/customer/resend-email (auth via Shopify session token)
4. Rate limit check (1/voucher/h)
5. SendGrid invia stessa email (stesso codice, stesso QR URL)
```

### Flusso D: Refund / Cancellation
```
1. Merchant/customer rimborsa ordine su Shopify
2. Webhook orders/refunded (o orders/cancelled) → App
3. UPDATE vouchers SET status='refunded' 
     WHERE order_id=$id AND status='generated'
4. Voucher già riscattati → NON toccati (audit manuale)
5. Email notifica cliente (opzionale, configurabile)
6. ERP notificato (reverse payout)
```

### Flusso D-bis: Diritto di Recesso 14gg (art. 52 Codice Consumo)
```
Punti aperti da decidere
Per XtraWine: confermiamo withdrawal_applicable = true (voucher open-dated)?
Vogliamo gestire subito il caso voucher usato parzialmente? Oggi è escluso (status redeemed → recesso negato per legge art. 59 lett. a). OK così.
Doppia conferma UI: il cliente deve cliccare "Recedi" → modal di conferma → email di conferma. Confermi UX?

Premessa legale:
  - Applicabile solo a consumatori B2C su acquisti a distanza.
  - Escluso per servizi tempo libero a DATA FISSA (art. 59 lett. n).
  - Voucher open-dated XtraWine → APPLICABILE (data scelta post-acquisto).
  - Configurabile per-experience via experience_products.withdrawal_applicable.

1. Alla generazione voucher (Flusso A):
   - Se experience.withdrawal_applicable = true:
       withdrawal_deadline_at = created_at + 14 giorni
   - Email voucher include: informativa recesso + link self-service
     (requisito formale: il termine decorre solo se l'informativa è data;
      altrimenti si estende a 12 mesi — art. 53).

2. Cliente esercita il recesso:
   (a) Self-service dal Customer Account Shopify:
         POST /api/customer/voucher/:code/withdraw (auth session token)
   (b) Modulo tipo scaricabile (allegato I parte B Codice Consumo) via email support

3. Validazione server-side (atomica):
   UPDATE vouchers
     SET status='withdrawn', withdrawal_requested_at=NOW()
   WHERE code=$1
     AND status='generated'
     AND withdrawal_deadline_at IS NOT NULL
     AND NOW() <= withdrawal_deadline_at
   RETURNING id, order_id;

4. Se UPDATE ritorna 0 righe → errore human-readable:
   - status='redeemed' → "Voucher già utilizzato, recesso non esercitabile (art. 59 lett. a)"
   - NOW() > deadline  → "Termine di 14 giorni scaduto il <data>"
   - withdrawal_deadline_at IS NULL → "Esperienza a data fissa, recesso escluso per legge"

5. Trigger rimborso su Shopify:
   - Admin API: refundCreate(order_id, line_item voucher, reason='customer_withdrawal')
   - Rimborso integrale entro 14gg dalla richiesta (obbligo art. 56).
   - Job retry idempotente (se Shopify API down → DLQ + alert merchant).

6. Email conferma al cliente + notifica merchant + ERP reverse payout.

7. Audit trail: voucher_events registra evento 'withdrawn' con IP + user agent.
```

Differenze chiave vs refund (Flusso D):
| Aspetto              | Refund (Flusso D)        | Recesso 14gg (Flusso D-bis)          |
|----------------------|--------------------------|--------------------------------------|
| Trigger              | Merchant su Shopify      | Cliente self-service                 |
| Obbligo legale       | No (discrezionale)       | Sì (diritto consumatore)             |
| Finestra             | Illimitata lato merchant | 14 giorni dall'acquisto              |
| Motivazione          | Richiesta               | Non richiesta                        |
| Su voucher riscattato| Non tocca voucher        | Esclusa per legge                    |
| Rimborso             | Manuale merchant         | Automatico via Admin API (obbligo)   |

### Flusso E: Upsell PDP (Theme App Extension)
```
1. Cliente visita PDP di un prodotto fisico (es. "Barolo 2015 - Pippo Rossi")
2. App Block risolve il partner_key del prodotto secondo partner_mapping_mode:
     - vendor      → product.vendor
     - collection  → collection handle associata
     - metaobject  → metaobject referenziato
     - tag         → primo tag con il prefisso configurato
3. Fetch GET /api/public/experience-for-partner/:partnerKey (cached 60s)
4. Se experience disponibile → render box con {{partner_label}} del merchant
   (es. XtraWine: "🎫 Visita la Cantina"; birrificio: "🍺 Visita il Birrificio")
5. Click → add-to-cart del product experience
```

### Flusso F: GDPR (solo per modalità Public App)
```
- customers/data_request → job async che compila JSON PII → email merchant
- customers/redact       → anonimizza customer_email in vouchers + voucher_events
- shop/redact            → 48h dopo uninstall: purge totale shop_id + cascade
```

### Flusso G: Export Voucher per il Partner (XML / CSV per gestionale)
```
Obiettivo:
  Permettere all'amministrazione del Partner (es. ufficio amministrativo Antinori)
  di scaricare i propri voucher in un formato apribile in Excel e importabile
  nei principali gestionali italiani (Zucchetti, TeamSystem, Fatture in Cloud).

1. Staff Partner in dashboard.<app>.com → sezione "Export"
2. Filtri: range date, status (multi-select), experience_type, formato (XML | CSV)
3. POST /api/partner/exports  { from, to, statuses, format }
4. Server enqueue job (export pesanti → async, link download via email)
   - Per export piccoli (<5k righe) → risposta sincrona stream
5. Query SEMPRE filtrata:
     WHERE shop_id = $session.shop_id
       AND shopify_partner_key = $session.partner_key
       AND created_at BETWEEN $from AND $to
   (RLS Postgres come secondo livello di difesa)
6. Generazione XML (UTF-8, schema versionato `vouchers-export-v1.xsd`):
     <?xml version="1.0" encoding="UTF-8"?>
     <VouchersExport xmlns="https://app.example.com/schema/vouchers/v1"
                     partnerKey="antinori" generatedAt="..." count="123">
       <Voucher>
         <Code>XW-7K4P-9M2A</Code>
         <Status>redeemed</Status>
         <ExperienceType>visita</ExperienceType>
         <ExperienceName>Visita guidata + degustazione 3 vini</ExperienceName>
         <Order number="#1042" date="2026-04-10T14:23:00Z"/>
         <Customer name="Mario Rossi" email="m.rossi@example.com"/>
         <Amount currency="EUR">4500</Amount>   <!-- centesimi -->
         <PurchasedAt>2026-04-10T14:23:00Z</PurchasedAt>
         <ExpiresAt>2027-04-10T23:59:59Z</ExpiresAt>
         <Booking forAt="2026-05-15T10:00:00Z" partySize="2" notes="..."/>
         <RedeemedAt>2026-05-15T10:12:00Z</RedeemedAt>
         <RedeemedBy>luca@antinori.it</RedeemedBy>
       </Voucher>
       ...
     </VouchersExport>
7. CSV equivalente (separator `;` per Excel IT, BOM UTF-8 per accentate)
8. Audit: ogni export → voucher_events 'exported' (chi, count, formato, hash file)
9. Download URL firmato (S3-style), TTL 1h, single-use
10. Conformità GDPR:
     - Email cliente: visibile solo a staff Partner del proprio partner_key
     - PII redatta su richiesta `customers/redact` (già evaso → export storico anonimizzato)
```

Formati supportati per il Partner:
| Formato | Uso tipico                                   | Note                          |
|---------|----------------------------------------------|-------------------------------|
| XML     | Import gestionale (Zucchetti/TeamSystem)     | Schema XSD versionato         |
| CSV     | Apertura diretta in Excel (sep. `;`)         | BOM UTF-8                     |
| JSON    | (futuro) integrazioni custom                 | Sprint 3+                     |

---

## ⚙️ Product Configuration (Lato Shopify)

La configurazione avviene dalla **Merchant Admin UI embedded** (Polaris), che scrive sui metafield Shopify via Admin API. L'ecommerce manager **non deve toccare JSON a mano**. **I Partner non vengono mai creati dall'Admin UI**: esistono già nel catalogo Shopify e vengono auto-rilevati.

### Metafield Schema (namespace `app`, access privato)

| Resource | Key | Type | Descrizione |
|----------|-----|------|-------------|
| Product | `is_experience` | boolean | Marca il prodotto come experience |
| Product | `partner_key` | single_line_text | Chiave logica del Partner (vendor name / collection handle / metaobject id / tag value). Opzionale se deducibile dal mapping mode. |
| Product | `validity_days` | number_integer | Giorni di validità voucher (default 365) |
| Product | `experience_type_key` | single_line_text | es. `visita`, `degustazione`, `tour`, `brewery-tour`, `spa-day`… |
| Order | `voucher_ids` | json (private) | Array di ID voucher generati (**non i codici**) |

### Setup iniziale (one-time, dall'Admin UI embedded)
1. Installa app sul merchant (OAuth flow)
2. **Step Partner Mapping**: scegli come i tuoi Partner sono modellati su Shopify (`vendor` / `collection` / `metaobject` / `tag`)
3. **Step Label**: scegli come chiamarli nell'UI e nelle email (es. XtraWine = "Cantina" / "Cantine")
4. **Step Partner auto-rilevati**: l'app elenca i Partner presenti nel catalogo. Per ognuno imposta email staff + `validity_days` + abilitato sì/no
5. **Step Experience**: marca i prodotti experience con toggle UI (scrive metafield automaticamente)
6. Aggiungi App Block "Experience Upsell" al tema dal Theme Editor
7. Lo staff riceve automaticamente l'email con magic link per il portale Partner

### Esempio XtraWine (caso cliente attuale)
- `partner_mapping_mode = vendor` (ogni vino ha come vendor il nome della cantina produttrice)
- `partner_label = "Cantina"`, `partner_label_plural = "Cantine"`
- Nessun lavoro aggiuntivo lato catalogo: tutte le cantine già esistenti su Shopify vengono rilevate automaticamente

### Email transazionali
- **Niente** template Shopify Email. Tutte le email del flusso voucher passano da SendGrid con template versionati in repo, parametrizzati con `{{partner_label}}`.
- Shopify Order Confirmation resta invariato (standard).

---

## 📅 Tempistiche Realistiche

Stima: **1-2 backend engineer** full-time. Tempistiche riviste per includere refund, GDPR e multi-tenant dal giorno 1 (scelte che altrimenti costerebbero 2-3x in rework).

### **SPRINT 1: MVP Core (2 settimane)** ✅

| Giorno | Task | Effort | Note |
|--------|------|--------|------|
| 1 | Scaffolding via Shopify App CLI (`npm init @shopify/app`) | 0.5d | OAuth, webhook registration, embedded ready |
| 1-2 | DB schema multi-tenant + RLS + migrations | 1.5d | `shops` (con partner_mapping_*), `partners`, `vouchers` con `shop_id` + `shopify_partner_key` |
| 3 | OAuth install flow + access_token cifrato | 1d | Anche per single merchant |
| 3 | **Partner Sync Service** (auto-discovery da Shopify) | 1d | Mode `vendor` abbastanza per XtraWine; altri mode Sprint 2 |
| 4-5 | Webhook `orders/paid` (HMAC + idempotenza + queue) | 2d | Risolve `partner_key` dal prodotto |
| 6 | Generazione voucher (Crockford Base32 + QR Cloudinary) | 1d | |
| 7 | **Webhook `orders/refunded` + `orders/cancelled`** | 1d | **Critico — non rinviabile** |
| 8 | SendGrid integration + template email voucher (con {{partner_label}}) | 1d | |
| 9 | Partner Dashboard MVP (lista + redeem atomico) | 1d | Label `Cantina` per XtraWine via config |
| 10 | Magic link auth (token hashato, TTL 1h, single-use) | 1d | |
| 11-12 | Test (unit + integration + HMAC fixtures) | 2d | |
| 13 | CI/CD + deploy staging (Render + Vercel + Supabase) | 1d | |
| 14 | UAT interno con dati reali XtraWine | 1d | |

**Output Sprint 1:** MVP production-ready con refund handling e multi-tenant schema.

### **SPRINT 2: Completamento (1.5 settimane)** 📋

| Task | Effort | Note |
|------|--------|------|
| Merchant Admin UI embedded (Polaris + App Bridge) | 3d | Setup mapping, label, lista Partner auto-rilevati, config experience |
| Partner Sync: mode `collection` + `metaobject` + `tag` | 1d | In MVP c'era solo `vendor` |
| Theme App Extension (PDP App Block) | 2d | Risolve partner_key da qualsiasi mapping mode |
| Resend email da Customer Account Shopify | 1d | Rate limit |
| **Booking Partner-side** (state `booked` + form + calendario) | 2d | API `/book`, vista calendario nella dashboard, ICS allegato in email |
| **Email reminder T-24h** + cron auto-`no_show` | 0.5d | BullMQ delayed job, configurabile per experience |
| **Export voucher XML/CSV** per amministrazione Partner | 1d | Schema XSD versionato, query isolata per `partner_key`, download firmato |
| Report dashboard Partner (daily/monthly + forecast `booked`) | 1d | Statistiche su prenotazioni e revenue forecast |
| Audit trail + export CSV admin merchant | 0.5d | |
| **GDPR mandatory webhooks** (data_request, redact, shop/redact) | 1d | **Obbligatorio anche in custom** |
| **Diritto di recesso 14gg** (self-service + auto-refund via Admin API) | 1.5d | **Obbligatorio B2C EU** — informativa, endpoint, stato `withdrawn`, refund automatico |
| Voucher info page pubblica (opzionale) | 0.5d | |
| Load test + query tuning | 1d | |

**Output Sprint 2:** Feature-complete, GDPR-compliant, App Store–ready sul piano compliance.

### **SPRINT 3: Enterprise + Public App Readiness (1 settimana)** 🚀

| Task | Effort | Note |
|------|--------|------|
| ERP integration formalization (queue, retry, DLQ) | 1.5d | |
| Fraud detection / anomaly alerting | 0.5d | |
| Shopify Billing API (AppSubscription) | 1d | Pronto per monetizzazione |
| i18n dashboard + email (IT/EN minimo) | 0.5d | |
| Monitoring (Datadog) + alert rules | 1d | |
| Data retention policy automatica (cron GDPR) | 0.5d | |
| Documentazione API + privacy policy + support page | 1d | Requisiti App Store |

**Output Sprint 3:** Enterprise-grade + requisiti minimi per submission App Store.

### **(Opzionale) SPRINT 4: App Store Submission (1-3 settimane)** 🏪

Solo se si decide di pubblicare:
- Listing store (screenshot, video demo, descrizione)
- App review process Shopify (iterazioni su feedback: 1-3 settimane)
- Onboarding flow multi-merchant
- Pricing plan tiers

---

## 📊 Timeline Gantt

```
Sprint 1 (MVP core + refund)    ████████████████ (14 giorni)
Sprint 2 (Complete + GDPR + Recesso + Booking + Export)  ██████████████ (14.5 giorni)
Sprint 3 (Enterprise + App-ready)                ███████ (7 giorni)
Sprint 4 (App Store, opzionale)                         █████████████ (15-20 giorni)

Totale per production custom merchant: ~6-7 settimane
Totale per App Store public release:   ~9-11 settimane
```

---

## 💰 Benefici Attesi

| Beneficio | Impatto | Timeline |
|-----------|---------|----------|
| **Aumenta AOV** | +15-25% clienti comprando experience | Post-launch |
| **Nuova revenue stream** | Commission from wineries | Post-launch |
| **Customer retention** | Experience = brand loyalty | Post-launch |
| **Operational efficiency** | Auto-generate + validate vouchers | Sprint 1 |
| **Scalability** | Supporta 100k+ voucher/anno | Sprint 3 |
| **Data insights** | Analytics su experience demand | Sprint 2 |

---

## ⚠️ Rischi e Mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|-------------|--------|------------|
| **Webhook timeout (>5s)** | Media | Alto | Queue asincrona: webhook risponde 200 subito, lavoro in background |
| **Race condition redeem** | Media | Alto | Atomic UPDATE con WHERE status='generated' + check rowCount |
| **Shopify API rate limit** | Bassa | Medio | Exponential backoff + bulk operations dove possibile |
| **Email deliverability** | Bassa | Medio | SendGrid con domain auth (SPF/DKIM/DMARC) + retry + DLQ |
| **Enumeration attack codici voucher** | Media | Medio | Rate limit info page, codici 12 char (58 bit entropia) |
| **Fraud — voucher rivenduto** | Bassa | Alto | Single-use + audit trail + possibilità blocco manuale |
| **Partner staff confusion** | Media | Medio | UX testing + video onboarding + demo voucher, label localizzata per verticale |
| **Leak access_token merchant** | Bassa | Critico | Cifratura at rest + rotation su sospetto compromesso |
| **Scale (N vouchers/day)** | Bassa | Alto | Indexes corretti + connection pooling + read replica |
| **Browser non supporta webcam (redeem)** | Media | Basso | Fallback input manuale codice sempre disponibile |

---

## 🎯 Success Criteria

- ✅ Webhook processing <500ms (p95), risposta 200 <2s anche sotto carico
- ✅ 99.9% uptime dashboard cantina
- ✅ Email delivery rate >98% (tracciato SendGrid)
- ✅ Zero duplicate vouchers (idempotenza verificata via load test)
- ✅ Redeem latency <100ms (p95)
- ✅ Refund → voucher invalidato entro 60s
- ✅ Booking → conferma email cliente entro 30s + reminder T-24h consegnato
- ✅ Export XML Partner → file disponibile entro 60s per <10k voucher, asincrono oltre
- ✅ Zero accessi cross-Partner: staff cantina A non vede mai dati cantina B (verificato da test automatico)
- ✅ GDPR request evasa entro SLA Shopify (30gg, target interno 7gg)
- ✅ Customer satisfaction >4.0/5 (survey post-redeem)
- ✅ Zero leak di codici voucher nei metafield pubblici (audit automatico)

---

## 📋 Decisioni Rimanenti

Prima di Green Light:

1. **PDP Widget Design:** Sticky, inline, o modal? (raccomando inline come App Block)
2. **Partner Onboarding:** video tutorial + email docs self-service (raccomandato); per XtraWine: label "Cantina" ovunque
3. **Pricing Model (per eventuale App Store):** flat mensile per merchant + commission opzionale per redeem
4. **Dispute Handling:** merchant-level dispute tool nell'Admin UI (Sprint 3)
5. **International:** Solo Italia al lancio, EU expansion appena si entra su App Store
6. **Go/No-Go Public App:** decisione da prendere entro fine Sprint 2 (molti task Sprint 3 cambiano scope)

---

## 🚀 Go/No-Go Recommendation

### ✅ **RECOMMENDATION: GO**

**Motivi:**
1. Architettura tecnicamente solida (no innovation risk)
2. Timeline realistica (5-6 settimane per custom, 8-10 per App Store)
3. Benefici chiari e misurabili (AOV lift, nuova revenue stream)
4. Stack standard, team può deliverare senza specialisti
5. Rischi mitigabili, nessun blocker architetturale
6. **Il design multi-tenant dal giorno 1 apre l'opzione App Store con effort marginale**

**Prossimo Step:** Approvazione stakeholder + kick-off Sprint 1

---

## 🏪 Future: Shopify App Store (roadmap sintetica)

La verticalizzazione come app pubblica è **fattibile con effort incrementale di ~15-20 giorni** grazie alle scelte architetturali di v1.1:

| Requisito App Store | Già coperto in v1.1 | Delta necessario |
|---------------------|---------------------|------------------|
| Multi-tenant DB | ✅ (shops table + RLS) | — |
| OAuth 2.0 flow | ✅ (Sprint 1) | — |
| Embedded Admin UI (App Bridge + Polaris) | ✅ (Sprint 2) | — |
| Theme App Extension | ✅ (Sprint 2) | — |
| GDPR mandatory webhooks | ✅ (Sprint 2) | — |
| Shopify Billing API | ✅ (Sprint 3) | — |
| Listing + assets (screenshot, video, docs) | ❌ | 3-5 giorni |
| App review iteration | ❌ | 5-15 giorni (Shopify-dipendente) |
| Privacy policy + support page | ✅ (Sprint 3) | — |
| Onboarding flow post-install | ⚠️ parziale | 2-3 giorni |

---

## 📞 Contatti

**Tech Lead:** [Nome]  
**Product:** [Nome]  
**Timeline Approval Needed By:** [Data]  
**Estimated Launch:** [Data + 4 settimane]

---

**Documento Preparato:** 23 Aprile 2026  
**Ultimo aggiornamento:** 23 Aprile 2026 (v1.1 — multi-tenant & App Store ready)  
**Prossima Review:** Dopo approvazione stakeholder
