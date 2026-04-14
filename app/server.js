'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express     = require('express');
const compression = require('compression');
const crypto      = require('crypto');

const { readConfig, writeConfig, getJiraToken, setLocalToken, hasToken, isTokenFromEnv, isBaseUrlFromEnv, isEmailFromEnv, CONFIG_PATH } = require('./src/config');
const { testConnection, getStatuses, getIssueTypes, getStatusesForJql, getBoards, fetchTeamIssues, previewJql, getLabels, getCustomFields } = require('./src/jira');
const { calculateTeamMetrics, buildCommitmentJql } = require('./src/metrics');
const { getCache, getStaleCache, setCache, clearCache, getCacheStatus } = require('./src/cache');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(compression({ level: 6, threshold: 512 }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper: derive TTL from config (avoids repeating the same expression)
function configTtlMs(cfg) {
  return (cfg.dashboard?.refreshIntervalMinutes || 15) * 60 * 1000;
}

// Helper: build ETag from the lastUpdated timestamp stored in the data object.
function makeEtag(data) {
  return `"${Buffer.from(data.lastUpdated || '').toString('base64')}"`;
}

// In-flight build promise — prevents thundering herd when cache expires.
// Concurrent /api/data requests coalesce onto the same build rather than
// each launching their own full Jira fetch.
let _inflightBuild = null;

// ── Dashboard data ────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const config = readConfig();
    const ttlMs  = configTtlMs(config);

    // 1) Fresh cache — fastest path
    const cached = getCache();
    if (cached) {
      const etag = makeEtag(cached);
      res.set('Cache-Control', 'private, no-cache');
      res.set('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      return res.json({ ...cached, fromCache: true });
    }

    // 2) Stale-while-revalidate: return stale data immediately, rebuild in background (C1)
    const stale = getStaleCache();
    if (stale) {
      if (!_inflightBuild) {
        _inflightBuild = buildDashboardData(config)
          .then(fresh => { setCache(fresh, ttlMs); return fresh; })
          .finally(() => { _inflightBuild = null; });
      }
      const etag = makeEtag(stale);
      res.set('Cache-Control', 'private, no-cache');
      res.set('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      return res.json({ ...stale, fromCache: true, stale: true });
    }

    // 3) No cache at all — must wait for first build
    if (!_inflightBuild) {
      _inflightBuild = buildDashboardData(config)
        .then(fresh => { setCache(fresh, ttlMs); return fresh; })
        .finally(() => { _inflightBuild = null; });
    }
    const fresh = await _inflightBuild;
    const etag = makeEtag(fresh);
    res.set('Cache-Control', 'private, no-cache');
    res.set('ETag', etag);
    res.json({ ...fresh, fromCache: false });
  } catch (err) {
    console.error('/api/data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (_req, res) => {
  res.json({
    ...getCacheStatus(),
    hasToken: hasToken(),
    tokenFromEnv: isTokenFromEnv()
  });
});

// ── Admin: Config ─────────────────────────────────────────────────────
// Public endpoint to verify admin password (no auth required — password is client-side only gating)
app.post('/api/admin/check-password', (req, res) => {
  try {
    const { password } = req.body || {};
    const config = readConfig();
    const expected = config.dashboard?.adminPassword || 'OKR3.2';
    res.json({ ok: password === expected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/config', (_req, res) => {
  try {
    const config = readConfig();
    res.json({ ...config, hasToken: hasToken(), tokenFromEnv: isTokenFromEnv(), baseUrlFromEnv: isBaseUrlFromEnv(), emailFromEnv: isEmailFromEnv() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export config as config.default.json — download this, commit to git, redeploy to persist settings.
app.get('/api/admin/config/export', (_req, res) => {
  try {
    const config = readConfig();
    // Strip env-var-managed connection fields so they don't get baked into the export
    const exportConfig = JSON.parse(JSON.stringify(config));
    if (isBaseUrlFromEnv()) delete exportConfig.jira?.baseUrl;
    if (isEmailFromEnv())   delete exportConfig.jira?.email;
    // Strip runtime-only flags
    delete exportConfig.hasToken;
    delete exportConfig.tokenFromEnv;
    delete exportConfig.baseUrlFromEnv;
    delete exportConfig.emailFromEnv;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="config.default.json"');
    res.send(JSON.stringify(exportConfig, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import config from uploaded file — updates both config.json and config.default.json for persistence
app.post('/api/admin/config/import', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Ungültige Konfiguration.' });
    }

    // Validate structure
    if (!body.jira || typeof body.jira !== 'object') {
      return res.status(400).json({ error: 'jira-Sektion fehlt.' });
    }
    if (!body.dashboard || typeof body.dashboard !== 'object') {
      return res.status(400).json({ error: 'dashboard-Sektion fehlt.' });
    }
    if (!Array.isArray(body.teams)) {
      return res.status(400).json({ error: 'teams muss ein Array sein.' });
    }

    // Validate teams
    for (const t of body.teams) {
      if (!t.name || typeof t.name !== 'string' || !t.name.trim()) {
        return res.status(400).json({ error: 'Jedes Team benötigt einen Namen.' });
      }
      if (!t.jql || typeof t.jql !== 'string' || !t.jql.trim()) {
        return res.status(400).json({ error: `Team "${t.name}": JQL-Filter fehlt.` });
      }
    }

    // Ensure all teams have IDs
    const teamsWithIds = body.teams.map(t => ({
      ...t,
      id: t.id || crypto.randomUUID()
    }));

    const configToSave = {
      ...body,
      teams: teamsWithIds
    };

    // Write runtime config through the shared config module so in-memory state stays in sync.
    writeConfig(configToSave);

    // Also write config.default.json so the same settings can be re-imported after redeploys.
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const defaultPath = path.join(dir, 'config.default.json');
    const defaultConfig = JSON.parse(JSON.stringify(configToSave));
    if (isBaseUrlFromEnv()) delete defaultConfig.jira?.baseUrl;
    if (isEmailFromEnv())   delete defaultConfig.jira?.email;
    fs.writeFileSync(defaultPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');

    clearCache();

    res.json({ ok: true, message: `Konfiguration mit ${teamsWithIds.length} Team(s) importiert.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/config', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Ungültige Konfiguration.' });
    }
    if (body.teams && !Array.isArray(body.teams)) {
      return res.status(400).json({ error: 'teams muss ein Array sein.' });
    }
    if (body.teams) {
      for (const t of body.teams) {
        if (!t.name || typeof t.name !== 'string' || !t.name.trim()) {
          return res.status(400).json({ error: 'Jedes Team benötigt einen Namen.' });
        }
        if (!t.jql || typeof t.jql !== 'string' || !t.jql.trim()) {
          return res.status(400).json({ error: `Team "${t.name}": JQL-Filter fehlt.` });
        }
      }
    }
    // Assign IDs to new teams
    if (body.teams) {
      body.teams = body.teams.map(t => ({
        ...t,
        id: t.id || crypto.randomUUID()
      }));
    }
    writeConfig(body);
    clearCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Token is write-only — never returned to the client
// Also accepts email + baseUrl so the connection test works immediately after saving
app.post('/api/admin/token', (req, res) => {
  try {
    const { token, email, baseUrl } = req.body;
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'Token darf nicht leer sein.' });
    }
    setLocalToken(token.trim());

    // Persist email + baseUrl so Jira API calls work immediately (local dev only)
    // If JIRA_EMAIL env var is set, skip saving email to config.json
    if (email || baseUrl) {
      const config = readConfig();
      if (email && !(process.env.JIRA_EMAIL && process.env.JIRA_EMAIL.trim())) {
        config.jira.email = email.trim();
      }
      if (baseUrl) config.jira.baseUrl = baseUrl.trim();
      writeConfig(config);
    }

    clearCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Admin: Jira ────────────────────────────────────────────────────────
app.get('/api/admin/jira/test', async (_req, res) => {
  try {
    const config = readConfig();
    const token  = getJiraToken();
    if (!token) return res.json({ ok: false, error: 'Kein API Token konfiguriert.' });
    const result = await testConnection(config.jira, token);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/admin/jira/boards', async (_req, res) => {
  try {
    const config = readConfig();
    const token  = getJiraToken();
    if (!token) return res.status(400).json({ error: 'Kein API Token konfiguriert.' });
    const boards = await getBoards(config.jira, token);
    res.json(boards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/jira/statuses', async (_req, res) => {
  try {
    const config   = readConfig();
    const token    = getJiraToken();
    if (!token) return res.status(400).json({ error: 'Kein API Token konfiguriert.' });
    const rawStatuses = await getStatuses(config.jira, token);
    // Sort: In Progress first, Done second, To Do third, rest alphabetically
    const CATEGORY_ORDER = { 'In Progress': 0, 'Done': 1, 'To Do': 2 };
    const sorted = rawStatuses.sort((a, b) => {
      const ca = CATEGORY_ORDER[a.category] ?? 9;
      const cb = CATEGORY_ORDER[b.category] ?? 9;
      return ca !== cb ? ca - cb : a.name.localeCompare(b.name);
    });
    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/jira/issuetypes', async (_req, res) => {
  try {
    const config = readConfig();
    const token  = getJiraToken();
    if (!token) return res.status(400).json({ error: 'Kein API Token konfiguriert.' });
    const types = await getIssueTypes(config.jira, token);
    res.json(types);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Returns only statuses actually used by a given JQL (for team status override)
app.post('/api/admin/jira/statuses-for-jql', async (req, res) => {
  try {
    const { jql } = req.body;
    if (!jql || typeof jql !== 'string' || !jql.trim()) {
      return res.status(400).json({ error: 'JQL fehlt.' });
    }
    const config = readConfig();
    const token  = getJiraToken();
    if (!token) return res.status(400).json({ error: 'Kein API Token konfiguriert.' });
    const statuses = await getStatusesForJql(jql.trim(), config.jira, token);
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/jira/preview', async (req, res) => {
  try {
    const { jql } = req.body;
    if (!jql || typeof jql !== 'string' || !jql.trim()) {
      return res.status(400).json({ error: 'JQL fehlt.' });
    }
    const config = readConfig();
    const token  = getJiraToken();
    if (!token) return res.status(400).json({ error: 'Kein API Token konfiguriert.' });
    const count = await previewJql(jql.trim(), config.jira, token);
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Returns labels available in Jira (for work item category configuration)
app.get('/api/admin/jira/labels', async (_req, res) => {
  try {
    const config = readConfig();
    const token  = getJiraToken();
    if (!token) return res.status(400).json({ error: 'Kein API Token konfiguriert.' });
    const labels = await getLabels(config.jira, token);
    res.json(labels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Returns custom fields available in Jira (for work item category configuration)
app.get('/api/admin/jira/fields', async (_req, res) => {
  try {
    const config = readConfig();
    const token  = getJiraToken();
    if (!token) return res.status(400).json({ error: 'Kein API Token konfiguriert.' });
    const fields = await getCustomFields(config.jira, token);
    res.json(fields);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Returns statuses only for a given JQL + optional issue type filter
// Body: { jql: string, issueTypes?: string[] }
app.post('/api/admin/jira/statuses-for-types', async (req, res) => {
  try {
    let { jql, issueTypes } = req.body;
    if (!jql || typeof jql !== 'string' || !jql.trim()) {
      return res.status(400).json({ error: 'JQL fehlt.' });
    }
    const config = readConfig();
    const token  = getJiraToken();
    if (!token) return res.status(400).json({ error: 'Kein API Token konfiguriert.' });

    let filteredJql = jql.trim();
    if (issueTypes?.length) {
      const quoted = issueTypes.map(t => `"${t.replace(/"/g, '\\"')}"`).join(', ');
      filteredJql += ` AND issuetype in (${quoted})`;
    }
    const statuses = await getStatusesForJql(filteredJql, config.jira, token);
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview count of committed items for a given commitment configuration
// Body: { teamJql: string, commitment: object }
app.post('/api/admin/jira/commitment-preview', async (req, res) => {
  try {
    const { teamJql, commitment } = req.body;
    if (!teamJql || !commitment) {
      return res.status(400).json({ error: 'teamJql und commitment sind erforderlich.' });
    }
    const config = readConfig();
    const token  = getJiraToken();
    if (!token) return res.status(400).json({ error: 'Kein API Token konfiguriert.' });

    const jql = buildCommitmentJql(teamJql, commitment);
    if (!jql) return res.status(400).json({ error: 'Ungültige Commitment-Konfiguration.' });

    const count = await previewJql(jql, config.jira, token);
    res.json({ count, jql });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: Refresh ─────────────────────────────────────────────────────
app.post('/api/admin/refresh', async (_req, res) => {
  try {
    clearCache();
    _inflightBuild = null; // force a fresh build, discard any coalesced in-flight
    const config = readConfig();
    const fresh  = await buildDashboardData(config);
    setCache(fresh, configTtlMs(config));
    startBackgroundRefresh();
    res.json({ ok: true, teams: fresh.teams.length, lastUpdated: fresh.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pages ──────────────────────────────────────────────────────────────
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Concurrency limiter ────────────────────────────────────────────────
// Runs `tasks` (array of async functions) with at most `limit` running in
// parallel. Returns a results array in the same order as `tasks`.
function limitConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function run() {
    let i;
    while ((i = idx++) < tasks.length) {
      results[i] = await tasks[i]();
    }
  }
  return Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, run)
  ).then(() => results);
}

const JIRA_CONCURRENCY = 5; // max parallel Jira fetches (conservative for rate limits)

// ── Build dashboard data ────────────────────────────────────────────────
async function buildDashboardData(config) {
  const token = getJiraToken();
  if (!token) {
    throw new Error(
      'Kein Jira API Token konfiguriert. Bitte unter /admin einrichten.'
    );
  }

  const teams   = config.teams || [];

  // Collect any custom field IDs referenced by workItemCategories
  const customFieldIds = (config.jira?.workItemCategories || [])
    .filter(c => c.filter?.method === 'customField' && c.filter?.customFieldId)
    .map(c => c.filter.customFieldId);

  // Fetch all teams in parallel (up to JIRA_CONCURRENCY at a time)
  const tasks = teams.map(team => async () => {
    try {
      const issues  = await fetchTeamIssues(team, config.jira, token, customFieldIds);
      const metrics = calculateTeamMetrics(issues, team, config);
      // Include which issue types were configured (for dashboard badge display)
      const effectiveTypes = team.issueTypes?.length
        ? team.issueTypes
        : (config.jira?.defaultIssueTypes?.length ? config.jira.defaultIssueTypes : null);
      return { id: team.id, name: team.name, bu: team.businessUnit || '', issueTypesConfig: effectiveTypes || [], ...metrics };
    } catch (err) {
      console.error(`Team "${team.name}":`, err.message);
      return { id: team.id, name: team.name, bu: team.businessUnit || '', error: err.message };
    }
  });
  const results = await limitConcurrency(tasks, JIRA_CONCURRENCY);

  return {
    teams: results,
    lastUpdated: new Date().toISOString(),
    iteration: config.dashboard?.iteration || 1,
    dashboardTitle: config.dashboard?.title || 'Delivery Health Dashboard',
    refreshIntervalMinutes: config.dashboard?.refreshIntervalMinutes || 15,
    backgroundRefreshMinutes: config.dashboard?.backgroundRefreshMinutes || 0,
    totalConfiguredTeams: teams.length,
    jiraBaseUrl: config.jira?.baseUrl || '',
    workItemCategories: config.jira?.workItemCategories || []
  };
}

app.listen(PORT, () => {
  console.log(`\n  Dashboard: http://localhost:${PORT}`);
  console.log(`  Admin:     http://localhost:${PORT}/admin\n`);
  startBackgroundRefresh();
});

// ── Background Refresh ─────────────────────────────────────────────────
let _bgTimer = null;

function startBackgroundRefresh() {
  if (_bgTimer) { clearInterval(_bgTimer); _bgTimer = null; }

  const config = readConfig();
  const intervalMin = config.dashboard?.backgroundRefreshMinutes;
  if (!intervalMin || intervalMin <= 0) return; // disabled

  const intervalMs = intervalMin * 60 * 1000;
  console.log(`  Background-Refresh aktiv: alle ${intervalMin} Min.`);

  _bgTimer = setInterval(async () => {
    try {
      const cfg   = readConfig();
      if (!hasToken()) return;
      console.log(`[${new Date().toISOString()}] Background-Refresh…`);
      const fresh = await buildDashboardData(cfg);
      setCache(fresh, configTtlMs(cfg));
      console.log(`[${new Date().toISOString()}] Background-Refresh abgeschlossen.`);
    } catch (err) {
      console.error('Background-Refresh Fehler:', err.message);
    }
  }, intervalMs);
}
