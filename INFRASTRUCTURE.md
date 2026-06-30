# XtraWine Experience Platform - Infrastructure Guide

**Data:** 23 Aprile 2026  
**Versione:** 1.3  
**Tech Stack:** Render + Vercel + Supabase + Redis + Klaviyo + Cloudinary

> **Nota v1.3:** allineato a PROJECT_SCOPE v1.4. Email transazionale migrata da SendGrid a **Klaviyo** (già in uso da XtraWine, dominio autenticato). Aggiunti: endpoint ERP `/api/order-vouchers`, scopo `write_discounts` per cross-selling, variabili `PAYPAL_DELAY_MINUTES` e `DISCOUNT_VALIDITY_DAYS`. I Partner **non sono creati dalla nostra app**: vengono letti dal catalogo Shopify del merchant (`vendor` / `collection` / `metaobject` / `tag`). La label UI per XtraWine è "Cantina".

---

## 📐 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    PRODUCTION STACK                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Frontend Layer (CDN + Edge Computing)                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Vercel                                              │   │
│  │  ├─ Next.js Partner Dashboard (dashboard.<app>.com)  │   │
│  │  ├─ Next.js Merchant Admin embedded (Polaris +       │   │
│  │  │   App Bridge, iframe in admin.shopify.com)        │   │
│  │  ├─ Edge functions per API pubbliche cacheable       │   │
│  │  ├─ Auto-scaling (0 → 1000s req/sec)                 │   │
│  │  └─ CDN global (latency < 100ms worldwide)           │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  API Layer (Compute)                                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Render (Node.js + TypeScript, Shopify App CLI)      │   │
│  │  ├─ Webhook handlers (orders/*, GDPR, app/*)         │   │
│  │  ├─ API endpoints tenant-scoped per shop_id          │   │
│  │  ├─ Background workers (queue: BullMQ su Redis)      │   │
│  │  ├─ OAuth install flow (access_token cifrato)        │   │
│  │  └─ Horizontal scaling (1-N istanze)                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Data Layer                                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Supabase (Managed PostgreSQL)                       │   │
│  │  ├─ Multi-tenant con Row-Level Security (shop_id)    │   │
│  │  ├─ Connection pooling (PgBouncer / transaction)     │   │
│  │  ├─ Backup giornalieri + Point-in-time recovery      │   │
│  │  ├─ SSL obbligatorio (sslmode=require)               │   │
│  │  └─ Read replica per analytics (Sprint 3)            │   │
│  │                                                      │   │
│  │  Redis (Render add-on o Upstash)                     │   │
│  │  ├─ Queue BullMQ (email, ERP, notifiche)             │   │
│  │  ├─ Rate limiting (redeem, resend, info page)        │   │
│  │  └─ Cache risposte PDP widget (TTL 60s)              │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Support Services                                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Klaviyo — email transazionale (voucher, notifica    │   │
│  │             cantina, cross-sell, report mensile)     │   │
│  │  Cloudinary — QR code signed URL, immagini cantine   │   │
│  │  Datadog — logging, metrics, alerting                │   │
│  │  AWS Secrets Manager (o Doppler) — secret rotation   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 🗂️ Repository Structure

Scaffolding generato da **Shopify App CLI** (`npm init @shopify/app@latest`) per avere già OAuth, webhook registration, App Bridge, session token middleware, Theme App Extension scaffolding e submission checklist.

```
xtra-experience/
│
├── shopify.app.toml                  # Shopify App config (scopes, webhooks, URLs)
├── shopify.web.toml                  # Web config
│
├── backend/                          # Node.js API (TypeScript)
│   ├── src/
│   │   ├── shopify/
│   │   │   ├── oauth.ts              # Install / callback flow
│   │   │   ├── session.ts            # Session token validation (App Bridge)
│   │   │   └── webhook-registry.ts   # Subscribe ai topic obbligatori
│   │   │
│   │   ├── webhooks/
│   │   │   ├── orders-paid.ts
│   │   │   ├── orders-refunded.ts
│   │   │   ├── orders-cancelled.ts
│   │   │   ├── app-uninstalled.ts
│   │   │   └── gdpr.ts               # data_request / redact / shop-redact
│   │   │
│   │   ├── api/
│   │   │   ├── partner/              # Partner Dashboard (magic link auth)
│   │   │   ├── customer/             # Resend + withdrawal (Shopify session token)
│   │   │   ├── admin/                # Merchant Admin embedded
│   │   │   ├── public/               # PDP widget endpoint (cacheable)
│   │   │   └── health.ts
│   │   │
│   │   ├── services/
│   │   │   ├── voucher.service.ts
│   │   │   ├── withdrawal.service.ts  # recesso 14gg + refundCreate via Admin API
│   │   │   ├── booking.service.ts     # state 'booked', calendario, ICS, reminder schedule
│   │   │   ├── export.service.ts      # XML (XSD) + CSV per amministrazione Partner
│   │   │   ├── email.service.ts      # Klaviyo Track API
│   │   │   ├── qr.service.ts         # Cloudinary signed URL
│   │   │   ├── shopify.service.ts    # Admin API wrapper
│   │   │   ├── erp-queue.service.ts
│   │   │   └── crypto.service.ts     # AES-GCM per access_token
│   │   │
│   │   ├── db/
│   │   │   ├── migrations/           # SQL migrations (con RLS policies)
│   │   │   ├── schema.sql
│   │   │   └── tenant-context.ts     # SET app.current_shop_id per request
│   │   │
│   │   ├── middleware/
│   │   │   ├── shopify-hmac.ts       # HMAC validation (timing-safe)
│   │   │   ├── shopify-session.ts    # App Bridge session token
│   │   │   ├── magic-link.ts         # Partner staff auth
│   │   │   ├── rate-limit.ts         # Redis-backed
│   │   │   └── error-handler.ts
│   │   │
│   │   ├── queue/
│   │   │   └── workers/              # BullMQ workers (email, ERP, reminders, exports, no-show cron)
│   │   │
│   │   ├── schemas/                  # XSD versionati per export XML
│   │   │   └── vouchers-export-v1.xsd
│   │   │
│   │   ├── emails/                   # Handlebars templates versionati
│   │   │
│   │   ├── utils/
│   │   │   ├── logger.ts             # Pino, PII-redaction
│   │   │   ├── base32.ts             # Crockford
│   │   │   └── hmac.ts
│   │   │
│   │   └── index.ts
│   │
│   ├── tests/                        # unit / integration / e2e
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── render.yaml
│
├── dashboard/                        # Next.js — Partner Dashboard (esterno)
│   ├── app/
│   │   ├── auth/verify/[token]       # Magic link verify
│   │   ├── partner/(protected)/...   # Dashboard, voucher, report
│   │   └── layout.tsx
│   ├── components/                   # VoucherList, RedeemScanner, ReportCard
│   ├── lib/                          # api client, auth helpers
│   └── vercel.json
│
├── admin-ui/                         # Next.js — Merchant Admin embedded
│   ├── app/
│   │   ├── layout.tsx                # AppProvider Polaris + App Bridge
│   │   ├── wineries/
│   │   ├── products/
│   │   ├── vouchers/
│   │   └── billing/
│   └── vercel.json
│
├── extensions/                       # Shopify extensions (CLI-managed)
│   └── pdp-experience-block/         # Theme App Extension (App Block)
│       ├── blocks/experience-upsell.liquid
│       ├── assets/experience.js
│       └── shopify.extension.toml
│
├── .github/workflows/
│   ├── test.yml
│   ├── deploy-staging.yml
│   └── deploy-production.yml
│
├── docker-compose.yml                # Postgres + Redis locali
├── .gitignore
├── README.md
├── PROJECT_SCOPE.md
└── INFRASTRUCTURE.md
```

---

## 🚀 Service Configuration

### 1. **Render (Backend)**

**Create new Web Service:**
```
Name: xtrawine-experience-api
Repository: your-github/xtra-experience
Branch: main
Build: npm install && npm run build
Start: npm start
Runtime: Node
Plan: Starter ($7/month) → Pro ($12/month) as needed
```

**Environment Variables (set in Render dashboard):**
```
NODE_ENV=production
LOG_LEVEL=info

# Shopify App (stessa app sia per custom merchant che per public release)
SHOPIFY_API_KEY=xxx
SHOPIFY_API_SECRET=xxx
SHOPIFY_APP_URL=https://api.xtrawine.com
SHOPIFY_SCOPES=read_orders,write_orders,read_products,write_discounts
SHOPIFY_WEBHOOK_SECRET=xxx           # alias di SHOPIFY_API_SECRET (firma webhook)
EXPERIENCE_PRODUCT_TYPE=Experience   # Valore "Product type" in Shopify per le experience

# Database (Supabase — pooled connection)
DATABASE_URL=postgresql://postgres:[PWD]@db.[REF].supabase.co:6543/postgres?pgbouncer=true&sslmode=require
DATABASE_URL_DIRECT=postgresql://postgres:[PWD]@db.[REF].supabase.co:5432/postgres?sslmode=require

# Redis (queue + rate limit)
REDIS_URL=rediss://...

# Email (Klaviyo — XtraWine usa già Klaviyo, dominio autenticato)
KLAVIYO_API_KEY=xxx                  # Private API Key, scope: Events - Write
KLAVIYO_FROM_EMAIL=noreply@xtrawine.com

# Cross-selling discount
DISCOUNT_VALIDITY_DAYS=30            # Giorni validità codice sconto post-acquisto experience

# PayPal anti-fraud delay
PAYPAL_DELAY_MINUTES=30              # Attesa min. prima invio email su ordini PayPal

# ERP integration
ERP_SHARED_SECRET=xxx                # Token condiviso per endpoint /api/order-vouchers

# Cloudinary (QR + assets)
CLOUDINARY_CLOUD_NAME=xxx
CLOUDINARY_API_KEY=xxx
CLOUDINARY_API_SECRET=xxx

# App
APP_URL=https://api.xtrawine.com
DASHBOARD_URL=https://dashboard.xtrawine.com
ADMIN_UI_URL=https://admin.xtrawine.com
JWT_SECRET=random-32-char-secret               # magic link JWT
ENCRYPTION_KEY=32-byte-base64                  # AES-GCM per access_token

# Datadog
DATADOG_API_KEY=xxx
DATADOG_SERVICE_NAME=xtrawine-api
```

**Health Check (monitored by Render):**
```
Path: /health
Check interval: 5 minutes
Expected status: 200
Timeout: 10 seconds
```

---

### 2. **Vercel (Frontend Dashboard)**

**Create new Project:**
```
Framework: Next.js
Repository: your-github/xtra-experience
Base: ./dashboard
```

**Environment Variables (set in Vercel dashboard):**
```
NEXT_PUBLIC_API_URL=https://api.xtrawine.com
NEXT_PUBLIC_APP_NAME=XtraWine Experience
NEXT_PUBLIC_SUPPORT_EMAIL=support@xtrawine.com

JWT_SECRET=same-as-backend
```

**vercel.json:**
```json
{
  "buildCommand": "npm run build",
  "outputDirectory": ".next",
  "env": {
    "NEXT_PUBLIC_API_URL": "@api_url"
  }
}
```

---

### 3. **Supabase (PostgreSQL Database)**

**Create Supabase Project:**
```
Organization: XtraWine
Project name: experience-platform
Region: eu-central-1 (closest to customers)
Database password: strong-random-password
```

**Connection Strings (pgbouncer pooled + direct per migrations):**
```
# App runtime (pooled, port 6543)
DATABASE_URL=postgresql://postgres:[PWD]@db.[REF].supabase.co:6543/postgres?pgbouncer=true&sslmode=require

# Migrations / psql (direct, port 5432)
DATABASE_URL_DIRECT=postgresql://postgres:[PWD]@db.[REF].supabase.co:5432/postgres?sslmode=require
```

**Multi-tenant RLS (abilitata dalla prima migration):**
```sql
ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vouchers
  USING (shop_id = current_setting('app.current_shop_id', true)::bigint);
-- idem per wineries, experience_products, voucher_events, ecc.
```

Ogni request del backend apre una transaction e fa `SET LOCAL app.current_shop_id = $1` prima di qualsiasi query → isolamento enforced a DB anche in caso di bug applicativo.

**Initial Setup:**
```bash
npm install -g supabase
supabase login
supabase link --project-ref [REF]
supabase migration new init_schema
supabase db push
```

---

### 4. **Klaviyo (Email Transazionale)**

XtraWine usa già Klaviyo con dominio `xtrawine.com` autenticato (SPF/DKIM/DMARC configurati). Non serve creare account né fare domain authentication.

**Setup:**
```
1. Klaviyo → Account → API Keys → crea Private API Key con scope "Events - Write"
2. Aggiungere la key alle env Render (KLAVIYO_API_KEY)
3. Luca crea i seguenti Flow in Klaviyo (trigger = evento custom):
```

**Flow da creare in Klaviyo:**

| Flow | Trigger | Destinatario | Contenuto |
|------|---------|-------------|----------|
| `Voucher Generated` | evento omonimo | cliente | codice voucher, QR, istruzioni, codice sconto cross-selling |
| `Voucher Sold` | evento omonimo | email cantina (`xw_experience.cantina_email`) | codice, nome cliente, ordine, scadenza |
| `Voucher Refunded` | evento omonimo | cliente | notifica invalidazione voucher per rimborso |
| `Voucher Monthly Report` | Cron mensile | email referente cantina | riepilogo voucher emessi / riscattati / scaduti del mese |

**Variabili evento `Voucher Generated` disponibili nel template Klaviyo:**
```
{{ event.code }}
{{ event.cantina_name }}
{{ event.experience_name }}
{{ event.expires_at }}
{{ event.qr_url }}
{{ event.url_experience }}
{{ event.instructions }}
{{ event.discount_code }}
{{ event.discount_description }}
{{ event.order_number }}
{{ event.payment_gateway }}   ← usato per ritardo 30min su PayPal (filtro nel Flow)
```

> **Nota PayPal:** nel Flow `Voucher Generated` aggiungere un branch: se `{{ event.payment_gateway }} == 'paypal'` → time delay 30 minuti prima dell'email. Questo rispetta il controllo antifrode PayPal prima di consegnare il voucher al cliente.

**Template (gestiti da Luca in Klaviyo, non nel repo):**
- Email voucher cliente (codice + QR + istruzioni + codice sconto)
- Notifica cantina (vendita voucher)
- Notifica rimborso cliente
- Report mensile cantina

---

### 4b. **Endpoint ERP `/api/order-vouchers`**

Endpoint dedicato su Vercel per la riconciliazione lato ERP/fatturazione.

```
GET /api/order-vouchers?order_id={shopify_order_id}&token={ERP_SHARED_SECRET}

Risposta 200:
[
  {
    "line_item_id": "...",
    "code": "XW-7K4P-9M2A",
    "cantina_name": "Marchesi Antinori",
    "experience_name": "Visita guidata + degustazione",
    "expires_at": "2027-05-13T23:59:59Z",
    "status": "generated | redeemed | refunded"
  }
]
```

Alternativa: lo stesso array è scritto come metafield ordine Shopify (`xw_experience.vouchers`) leggibile via Admin API — utile se l'ERP è già integrato con Shopify.

---

### 5. **Cloudinary (QR Code Hosting)**

**Setup:**
```
1. Create Cloudinary account (free tier: 25k transforms/month)
2. Generate API credentials
3. Use for:
   - Generate QR codes on-demand
   - Store images in CDN
   - Optimize for mobile viewing
```

---

### 6. **Datadog (Monitoring & Logging)**

**Setup:**
```
1. Create Datadog account (free tier for logging)
2. Add Datadog agent to Render (via integration)
3. Create dashboards for:
   - Request latency
   - Error rate
   - Webhook success rate
   - Database query time
4. Setup alerts (email/Slack)
```

---

## 💻 Local Development Setup

### Prerequisites
```bash
Node.js 20+
Docker Desktop
Shopify CLI: npm install -g @shopify/cli @shopify/app
Supabase CLI: npm install -g supabase
```

### Installation

```bash
git clone https://github.com/your-org/xtra-experience.git
cd xtra-experience

# Deps backend
cd backend && npm install && cd ..

# Deps frontend
cd dashboard && npm install && cd ..
cd admin-ui && npm install && cd ..

# Env
cp backend/.env.example backend/.env.local
cp dashboard/.env.example dashboard/.env.local
cp admin-ui/.env.example admin-ui/.env.local
```

### Start Services

```bash
# Postgres + Redis locali
docker-compose up -d

# Dev loop completo (Shopify CLI avvia tunnel Cloudflare, aggiorna URL app,
# registra i webhook e fa il proxy a localhost)
shopify app dev

# In parallelo (se non gestiti dal CLI):
# Terminal backend
cd backend && npm run dev          # http://localhost:3001

# Terminal Partner Dashboard
cd dashboard && npm run dev        # http://localhost:3000

# Terminal admin UI (embedded)
cd admin-ui && npm run dev         # http://localhost:3002

# Migrations (verso DB locale)
cd backend && npm run db:migrate:dev
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    container_name: xtrawine-postgres
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: xtrawine_dev
      POSTGRES_PASSWORD: dev_password
      POSTGRES_DB: xtrawine_dev
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U xtrawine_dev"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: xtrawine-redis
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

### Test Webhook Locally

Usa **Shopify CLI** (non Stripe CLI): crea tunnel Cloudflare, registra i webhook e forwarda al backend locale.

```bash
# Avvia dev loop completo
shopify app dev
# Il CLI stampa un URL tipo https://xxx.trycloudflare.com e registra i webhook

# Trigger manuale di un webhook su store di dev
shopify app webhook trigger \
  --topic=orders/paid \
  --delivery-method=http \
  --address=https://xxx.trycloudflare.com/webhooks/orders-paid

# Verifica HMAC localmente con fixture
curl -X POST http://localhost:3001/webhooks/orders-paid \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Hmac-SHA256: $(node scripts/sign-fixture.js fixtures/order-paid.json)" \
  -H "X-Shopify-Shop-Domain: xtrawine-dev.myshopify.com" \
  --data @fixtures/order-paid.json
```

---

## 🔄 Deployment Pipeline

### GitHub Actions Workflows

#### `.github/workflows/test.yml`
```yaml
name: Test

on:
  pull_request:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: 18
          cache: 'npm'
      
      - run: cd backend && npm install
      - run: cd backend && npm run test
      - run: cd backend && npm run lint
      
      - run: cd dashboard && npm install
      - run: cd dashboard && npm run build
      - run: cd dashboard && npm run lint
```

#### `.github/workflows/deploy-production.yml`
```yaml
name: Deploy Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Deploy Backend (Render)
        run: |
          curl https://api.render.com/deploy/srv-xxx?key=${{ secrets.RENDER_DEPLOY_KEY }}
      
      - name: Deploy Frontend (Vercel)
        run: |
          npx vercel deploy --prod \
            --token=${{ secrets.VERCEL_TOKEN }} \
            --scope=xtrawine
      
      - name: Run smoke tests
        run: |
          npm run test:e2e:prod
      
      - name: Notify Slack
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "✅ XtraWine API deployed to production"
            }
```

### Deployment Steps

```
Developer commits code
         ↓
GitHub Actions triggered
         ↓
Run tests (unit + integration)
         ↓
If pass:
  - Build backend Docker image
  - Push to Render
  - Build Next.js app
  - Deploy to Vercel
         ↓
Health checks (5 min timeout)
         ↓
Run E2E smoke tests
         ↓
Notify Slack channel
         ↓
Ready for traffic
```

---

## 📊 Cost Breakdown (Annual)

| Service | Usage | Cost/Month | Cost/Year |
|---------|-------|-----------|-----------|
| **Render (Backend + workers)** | 1-3 istanze | €20-50 | €240-600 |
| **Vercel (Dashboard + Admin UI)** | Pro plan | €20 | €240 |
| **Supabase (PostgreSQL)** | 5GB → 50GB | €0-30 | €0-360 |
| **Redis (Upstash o Render add-on)** | queue + rate limit | €10 | €120 |
| **Klaviyo (Email)** | già incluso nel piano XtraWine | €0 | €0 |
| **Cloudinary (QR + immagini)** | Free tier | €0 | €0 |
| **Datadog (Monitoring)** | Free + overage | €0-10 | €0-120 |
| **Dominio + SSL** | xtrawine.com (SSL via Vercel/Cloudflare) | €10 | €120 |
| **Backup storage (S3)** | Incrementale | €2 | €24 |
| | **TOTAL** | **€82-160** | **€984-1.920** |

**vs Heroku legacy:** €2.000+/anno  
**vs AWS Enterprise full:** €5.000+/anno  
**Savings:** 50-80% rispetto a stack legacy

---

## 🔐 Security Configuration

### Environment Variables (Secrets)
```bash
# Never commit .env files
# Store sensitive data in:
# - Render: Project Settings → Environment
# - Vercel: Settings → Environment Variables
# - Supabase: Project Settings → Database
# - AWS Secrets Manager (optional, for rotation)
```

### Database Security
```
- SSL obbligatorio (sslmode=require)
- IP allow-list Supabase (Render egress + IP DevOps)
- Row-level security (RLS) su TUTTE le tabelle tenant-scoped
- app.current_shop_id settato via SET LOCAL a inizio transaction
- Backup cifrati at rest (gestiti da Supabase)
- access_token Shopify cifrato a livello applicativo (AES-256-GCM)
```

### API Security
```
- Rate limiting (Redis):
    redeem: 10/IP/min
    resend: 1/voucher/h
    voucher info page: 30/IP/min
- CORS allow-list: *.myshopify.com, admin.shopify.com, dashboard.xtrawine.com
- HMAC timing-safe compare su tutti i webhook Shopify
- Session token Shopify (App Bridge) verificato su Admin UI
- Magic link: token hashato (no plaintext in DB), TTL 1h, single-use
- JWT session: 24h, revocabile via flag DB
- Log sanitizzati (PII redacted da logger)
```

### Audit & Compliance
```
- Ogni API call loggata (request id, shop_id, actor, IP, UA)
- GDPR mandatory webhooks implementati:
    customers/data_request → export JSON email merchant (SLA 30gg)
    customers/redact       → anonimizza PII nei voucher + audit
    shop/redact            → purge totale 48h post-uninstall
- Data retention: 2 anni su voucher storici, poi anonimizzati
- Audit trail immutabile per transazioni ERP (soft-delete only)
- Privacy policy + support page obbligatorie per App Store submission
```

---

## 📈 Scaling Strategy

### When to Scale

| Metric | Threshold | Action |
|--------|-----------|--------|
| **API response time** | > 200ms p95 | Add Render instance |
| **Database connections** | > 80% pool usage | Upgrade Supabase tier |
| **Error rate** | > 0.5% | Investigate + alerts |
| **Email queue depth** | > 1000 pending | Check Klaviyo delivery rate |

### Horizontal Scaling (Render)

```yaml
# Render auto-scales based on metrics:
# - CPU > 70% for 5 min → spin up new instance
# - CPU < 30% for 10 min → terminate instance
# Max instances: 10 (configurable)
# Min instances: 1
```

### Vertical Scaling (Database)

```
Small  (5GB):  Free tier    → 100 concurrent users
Medium (50GB): Pro plan     → 1,000 concurrent users
Large (500GB): Business     → 10,000+ concurrent users
```

---

## 🚨 Monitoring & Alerts

### Key Dashboards

```
1. System Health
   - API latency (target: < 200ms p95)
   - Error rate (target: < 0.1%)
   - Uptime (target: 99.9%)

2. Business Metrics
   - Webhooks processed/day
   - Vouchers generated/day
   - Redemption rate
   - Failed orders

3. Infrastructure
   - Database connections
   - Render instance load
   - Klaviyo event delivery rate
   - Datadog log volume
```

### Alert Rules (via Datadog + Slack)

```
🔴 Critical:
  - API down (5 min)
  - Webhook failures > 5% (15 min)
  - Database connection pool > 95% (5 min)
  
🟡 Warning:
  - API latency > 500ms (10 min)
  - Error rate > 1% (5 min)
  - Disk usage > 80% (5 min)
  
🔵 Info:
  - Deployments completed
  - Database backups completed
  - Daily summary (end of day)
```

---

## 🔄 Backup & Disaster Recovery

### Automated Backups

```
Database (Supabase):
  - Daily automated backups (7-day retention)
  - Point-in-time recovery (PITR) up to 7 days
  - Cross-region backup (optional)

Render:
  - Container logs: 7 days
  - Environment backups: automatic

Vercel:
  - Git history: unlimited
  - Deployments: 100 last deployments
```

### Manual Backup Procedure

```bash
# Export database weekly
supabase db pull --schema-only > backups/schema_$(date +%Y%m%d).sql
supabase db dump > backups/full_$(date +%Y%m%d).sql

# Upload to S3
aws s3 cp backups/ s3://xtrawine-backups/ --recursive
```

### Disaster Recovery Plan

```
RTO (Recovery Time Objective): 1 hour
RPO (Recovery Point Objective): 24 hours

If data loss:
1. Stop traffic (scale Render to 0 instances)
2. Restore from latest backup (Supabase recovery)
3. Verify data integrity
4. Scale Render back up
5. Run smoke tests
6. Resume traffic
```

---

## ✅ Pre-Launch Checklist

### Merchant custom (Sprint 1-3)
- [ ] Servizi creati e configurati (Render, Vercel ×2, Supabase, Redis, Klaviyo API key, Cloudinary)
- [ ] Env vars settate (nessun secret hardcoded, `.env*` in `.gitignore`)
- [ ] GitHub Actions verde su main (test + lint + build)
- [ ] Migrations applicate in staging + RLS policy attive
- [ ] HMAC verificato su webhook fixture (test automatico)
- [ ] Idempotenza webhook testata (stesso `X-Shopify-Webhook-Id` 2x → 1 sola scrittura)
- [ ] Refund flow testato end-to-end (voucher non ancora riscattato → invalidato)
- [ ] **Recesso 14gg**: endpoint `/api/customer/voucher/:code/withdraw` con validazione atomica testata
- [ ] **Recesso 14gg**: `refundCreate` su Shopify Admin API automatico post-withdraw (con retry/DLQ)
- [ ] **Recesso 14gg**: email voucher contiene informativa + link self-service + modulo tipo allegato
- [ ] **Recesso 14gg**: blocco corretto quando `status='redeemed'` o deadline scaduta o `withdrawal_applicable=false`
- [ ] **Booking**: endpoint `/api/partner/vouchers/:code/book` con UPDATE atomico filtrato su `partner_key` di sessione
- [ ] **Booking**: email conferma con allegato `.ics` consegnata
- [ ] **Booking**: reminder T-24h schedulato via BullMQ delayed job e consegnato (test E2E con job a TTL ridotto)
- [ ] **Booking**: cron `auto-no-show` marca `booked → no_show` per visite passate non riscattate
- [ ] **Isolamento Partner**: test automatico verifica che staff Partner A NON può leggere/prenotare/riscattare voucher di Partner B (anche manipolando body/URL)
- [ ] **Export XML/CSV**: validazione contro `vouchers-export-v1.xsd` in CI
- [ ] **Export XML/CSV**: download URL firmato TTL 1h single-use; query forzata su `partner_key` di sessione
- [ ] **Export XML/CSV**: PII anonimizzata negli export storici post-`customers/redact`
- [ ] Klaviyo: Flow `Voucher Generated`, `Voucher Sold`, `Voucher Refunded` attivi e testati (incluso branch ritardo PayPal 30 min)
- [ ] Klaviyo: evento `Voucher Generated` contiene `discount_code` e `instructions`
- [ ] Cloudinary signed URL con expiry funzionante
- [ ] Magic link: token hashato, TTL 1h, single-use verificato
- [ ] Access token Shopify cifrato a DB (decifratura ok al runtime)
- [ ] Metafield ordine voucher = `access.storefront: NONE` verificato
- [ ] Monitoring Datadog + alert rules attive
- [ ] Load test 1000 req/sec passato
- [ ] Backup + restore procedure testata

### Public App Store (solo se si procede con Sprint 4)
- [ ] GDPR mandatory webhooks implementati e testati
- [ ] `app/uninstalled` cleanup + soft-delete
- [ ] OAuth install flow completo (test con dev store)
- [ ] Billing API (AppSubscription) integrata e testata
- [ ] Embedded Admin UI con App Bridge + session token
- [ ] Theme App Extension testata su tema Dawn
- [ ] Privacy policy + support page pubblicate
- [ ] App listing: screenshot, video demo, descrizione
- [ ] Shopify App submission sottomessa

---

## 📞 Support & Escalation

| Issue | Owner | Escalation |
|-------|-------|------------|
| API down | Backend eng | Team lead → CTO |
| DB issues | DevOps / Supabase support | Premium support ticket |
| Frontend bugs | Frontend eng | Product manager |
| Email delivery | Backend eng | Klaviyo support |
| Payment issues | Shopify support | Shopify+ partner |

**SLA Response Times:**
- Critical (P1): 30 min
- High (P2): 2 hours
- Medium (P3): 8 hours
- Low (P4): Next business day

---

## 🎓 Team Training

**DevOps & Deployment:**
- How to deploy to Render
- How to rollback deployments
- How to read Datadog dashboards
- How to handle database emergencies

**Development:**
- Local development setup
- Testing webhook locally
- Database migrations
- Environment variables

**Monitoring:**
- How to check system health
- How to respond to alerts
- How to view logs
- How to create custom dashboards

---

**Document prepared:** 23 Aprile 2026  
**Last updated:** 23 Aprile 2026 (v1.2 — Partner abstraction, Shopify come source of truth, vertical-agnostic)  
**Next review:** After first deployment to production
