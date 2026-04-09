'use strict';
require('dotenv').config();

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const { readConfig, writeConfig, getJiraToken, setLocalToken, hasToken, isTokenFromEnv } = require('./src/config');
const { testConnection, getStatuses, getStatusesForJql, getBoards, fetchTeamIssues, previewJql } = require('./src/jira');
const { calculateTeamMetrics } = require('./src/metrics');
const { getCache, setCache, clearCache, getCacheStatus } = require('./src/cache');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Dashboard data ────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const config = readConfig();
    const cached = getCache();
    if (cached) return res.json({ ...cached, fromCache: true });

    const fresh = await buildDashboardData(config);
    setCache(fresh);
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
app.get('/api/admin/config', (_req, res) => {
  try {
    const config = readConfig();
    res.json({ ...config, hasToken: hasToken(), tokenFromEnv: isTokenFromEnv() });
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

// ── Admin: Refresh ─────────────────────────────────────────────────────
app.post('/api/admin/refresh', async (_req, res) => {
  try {
    clearCache();
    const config = readConfig();
    const fresh  = await buildDashboardData(config);
    setCache(fresh);
    res.json({ ok: true, teams: fresh.teams.length, lastUpdated: fresh.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pages ──────────────────────────────────────────────────────────────
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Build dashboard data ────────────────────────────────────────────────
async function buildDashboardData(config) {
  const token = getJiraToken();
  if (!token) {
    throw new Error(
      'Kein Jira API Token konfiguriert. Bitte unter /admin einrichten.'
    );
  }

  const teams   = config.teams || [];
  const results = [];

  for (const team of teams) {
    try {
      const issues  = await fetchTeamIssues(team, config.jira, token);
      const metrics = calculateTeamMetrics(issues, team, config);
      results.push({ id: team.id, name: team.name, bu: team.businessUnit || '', ...metrics });
    } catch (err) {
      console.error(`Team "${team.name}":`, err.message);
      results.push({ id: team.id, name: team.name, bu: team.businessUnit || '', error: err.message });
    }
  }

  return {
    teams: results,
    lastUpdated: new Date().toISOString(),
    iteration: config.dashboard?.iteration || 1,
    refreshIntervalMinutes: config.dashboard?.refreshIntervalMinutes || 15,
    totalConfiguredTeams: teams.length
  };
}

app.listen(PORT, () => {
  console.log(`\n  Dashboard: http://localhost:${PORT}`);
  console.log(`  Admin:     http://localhost:${PORT}/admin\n`);
});
