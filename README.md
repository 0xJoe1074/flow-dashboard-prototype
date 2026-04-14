# Infoniqadashboard

**Delivery Health Dashboard** – Flow Metrics (Throughput, Cycle Time, WIP) für Infoniqa-Teams aus Jira Cloud.

---

## ⚠️ Security Warning

**VPN-only access required!** This dashboard connects to `infoniqa.atlassian.net` Jira Cloud. Use only within Infoniqa VPN or approved network. Do not expose publicly without authentication.

---

## Tech Stack

| Component | Version |
|-----------|---------|
| Node.js   | 22 (Alpine) |
| Express   | 4.18+ |
| Jira API  | Cloud (OAuth2 / PAT) |
| Runtime   | Docker (Node 22-Alpine) |

**Dependencies:** `compression`, `dotenv`, `express`

---

## Hosting & Setup

**Go-to Person:** Joerg Schwinghammer

### Prerequisites

- Jira Cloud access (`infoniqa.atlassian.net`)
- Jira Personal Access Token (PAT)
  - Create: `id.atlassian.com → Security → API tokens`
  - Email: use your Infoniqa email account

### First-Time Setup

1. **Get PAT**  
   `id.atlassian.com → Security → API tokens → Create token`

2. **Create `.env` file** (root directory)  
   ```bash
   cd app
   npm install
   cp .env.example ../.env
   ```
   
3. **Edit `.env`** with Jira credentials:
   ```
   JIRA_API_TOKEN=<your PAT from step 1>
   JIRA_EMAIL=<your.email@brz.eu>
   PORT=3000
   ```

4. **Test connection**  
   Start app → http://localhost:3000/admin → "Jira Connection" → "Test"

---

## Local Development

```bash
cd app && npm install
npm run dev                    # Watch mode, auto-reload
npm start                      # Standard start
```

**Access:**
- Dashboard: http://localhost:3000
- Admin UI:  http://localhost:3000/admin

### Updating Jira Token (Local)

**Option A – Via `.env`** (requires server restart)
```bash
# Edit ../.env
JIRA_API_TOKEN=<new PAT>
# Restart npm run dev
```

**Option B – Via Admin UI** (no restart needed)  
`http://localhost:3000/admin → Jira Connection → Token → Save`

### Config Management

All team configs (JQL, statuses, refresh interval) are managed via Admin UI (`/admin`) and stored in `app/data/config.json`.

---

## Deployment

### Docker Build & Run

```bash
# Build
docker build -t infoniqadashboard .

# Run (with .env)
docker run -p 3000:3000 --env-file .env infoniqadashboard
```

**Production Notes:**
- Runs as non-root user (`nodeapp`)
- Alpine base (small footprint)
- Health check via `curl http://localhost:3000`
- Requires `.env` at runtime for Jira PAT

---

## Basic Features

| Metric | Type | Per-Team | Notes |
|--------|------|----------|-------|
| **Throughput** | Flow | ✓ | Items completed / week (12-week trend) |
| **Cycle Time** | Flow | ✓ | P50 / P85 (Closed − Activated) |
| **WIP** | Flow | ✓ | Current in-progress count & aging |
| **Flow Balance** | Flow | ✓ | Arrival rate ÷ Completion rate |
| **Cycle Scatterplot** | Viz | ✓ | Last 90 days, by work item type |
| **Work Mix** | Breakdown | ✓ | User Story / Tech Story / Bug % |
| **Business Unit Filter** | Portfolio | — | Slice by team business unit |

**Admin Features:**
- Token & Jira connection test
- JQL preview (validates team queries)
- Status mapping editor
- Custom field bindings
- Cache refresh control

---

## Project Structure

```
OKR3.2/
├── app/                      ← Express.js server & UI
│   ├── server.js             ← Entry point
│   ├── package.json          ← Dependencies
│   ├── src/                  ← Business logic
│   │   ├── jira.js           ← Jira API client
│   │   ├── metrics.js        ← Flow metric calculations
│   │   ├── config.js         ← Config I/O
│   │   └── cache.js          ← Cache layer
│   ├── public/               ← Dashboard HTML & static
│   └── data/                 ← config.json, cache store
├── Mockup/                   ← Static prototype mockups (reference)
├── Dockerfile                ← Production image
└── README.md                 ← This file
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **Token invalid** | Regenerate PAT at `id.atlassian.net` |
| **Connection timeout** | Check VPN, verify Jira URL in config.json |
| **Empty dashboard** | In Admin UI, verify JQL is correct & run "Preview JQL" |
| **Port 3000 in use** | Set `PORT=3001` in `.env` |

---

## Produktion (Azure)

### Architektur

```
Azure DevOps Pipeline
  → az acr build  →  Container Registry (crinternalproduction)
  → az container create  →  Azure Container Instances (rg-internal-production)
  → DNS Update  →  infoniqadashboard.internaltools.production.brz365.net
```

### Secrets & Konfiguration

Alle sensiblen Werte werden in der Azure DevOps **Variable Group `vg-infoniqadashboard`** verwaltet:

| Variable | Beschreibung | Secret |
|---|---|---|
| `JIRA_API_TOKEN` | Jira PAT des Service-Accounts | ✅ |
| `JIRA_EMAIL` | E-Mail des Service-Accounts | |
| `ACR_USERNAME` | Container Registry Username | |
| `ACR_PASSWORD` | Container Registry Password | ✅ |

Variable Groups verwalten: `Azure DevOps → Pipelines → Library → vg-infoniqadashboard`

### Deployment

Jeder Push auf `main` triggert automatisch die Pipeline (`.azure/azure.pipeline.yml`).

Manuell starten: `Azure DevOps → Pipelines → Infoniqadashboard → Run pipeline`

### Token aktualisieren (Prod)

Der Token-Input in der Admin-UI ist in Prod gesperrt (`JIRA_API_TOKEN_READONLY=true`).

1. `Azure DevOps → Pipelines → Library → vg-infoniqadashboard`
2. `JIRA_API_TOKEN` auf neuen PAT setzen (bei Ablauf neuen PAT unter `id.atlassian.com → Security → API tokens` generieren)
3. Pipeline neu starten → Container wird mit neuem Token neu deployt

### Logs & Debugging

```bash
# Container-Logs abrufen
az container logs \
  --resource-group rg-internal-production \
  --name infoniqadashboard

# Container-Status prüfen
az container show \
  --resource-group rg-internal-production \
  --name infoniqadashboard \
  --query "{state:instanceView.state, ip:ipAddress.ip}" -o table
```

---

## Projektstruktur

```
app/
  server.js          # Express-Server, API-Routen
  src/
    config.js        # Konfiguration & Token-Verwaltung
    jira.js          # Jira Cloud REST API Client
    metrics.js       # Flow-Metriken Berechnung
    cache.js         # In-Memory Cache
  public/
    index.html       # Dashboard
    admin.html       # Admin-UI
  data/
    config.json      # Team-Konfiguration (committed ohne E-Mail)
    .token           # Lokaler Token-Fallback (gitignored)
  .env.example       # Vorlage für lokale .env
.azure/
  azure.pipeline.yml # CI/CD Pipeline
Dockerfile           # Container Image (Node 22 Alpine)
.dockerignore
```
