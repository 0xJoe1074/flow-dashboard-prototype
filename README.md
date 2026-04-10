# Infoniqadashboard

Delivery Health Dashboard – Jira-backed Flow Metrics für Infoniqa-Teams.  
Visualisiert Durchsatz, Cycle Time, WIP und Flow Balance pro Team aus Jira Cloud.

---

## Lokale Entwicklung

### Voraussetzungen

- Node.js ≥ 18
- Zugang zu `infoniqa.atlassian.net` (VPN oder direkt)
- Jira Personal Access Token (PAT) – erstellen unter: `id.atlassian.com → Security → API tokens`

### Setup

```bash
# 1. Dependencies installieren
cd app
npm install

# 2. Umgebungsvariablen setzen
cp .env.example ../.env
# ../.env bearbeiten:
#   JIRA_API_TOKEN=<dein PAT>
#   JIRA_EMAIL=vorname.nachname@brz.eu

# 3. Server starten
npm run dev
```

Dashboard:  http://localhost:3000  
Admin-UI:   http://localhost:3000/admin

### Token aktualisieren (lokal)

Option A – `.env` direkt bearbeiten:
```
JIRA_API_TOKEN=<neuer PAT>
```
Server muss danach neu gestartet werden.

Option B – Admin-UI:  
`http://localhost:3000/admin` → Jira Verbindung → Token eingeben → „Token speichern"  
Der Token wird sofort aktiv (kein Neustart nötig) und in `../.env` persistiert.

### Konfiguration (Teams, JQL, Statuses)

Alle Team-Konfigurationen werden über die Admin-UI unter `/admin` verwaltet und in `app/data/config.json` gespeichert.

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
