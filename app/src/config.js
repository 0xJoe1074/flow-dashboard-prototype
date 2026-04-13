'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../data/config.json');
const TOKEN_PATH  = path.join(__dirname, '../data/.token');
const ENV_PATH    = path.join(__dirname, '../../.env');

const DEFAULT_CONFIG = {
  jira: {
    baseUrl: 'https://infoniqa.atlassian.net',
    email: '',
    defaultActiveStatus: 'In Progress',
    defaultDoneStatus: 'Done',
    defaultIssueTypes: [],
    // Iteration 2+: how to categorise work items (User Story / Tech Story / Bug etc.)
    // Each entry: { name, color, isValueWork, filter: { method: 'issueType'|'label'|'customField',
    //   issueTypes?: [], labelValue?: '', customFieldId?: '', customFieldValue?: '' } }
    workItemCategories: [],
    // Iteration 3: how to identify committed items
    // { method: 'label'|'parentEpic'|'fixVersion', labelValue, epicKey, fixVersionName,
    //   quarterStart: 'YYYY-MM-DD', quarterEnd: 'YYYY-MM-DD' }
    commitment: null
  },
  dashboard: {
    iteration: 1,
    refreshIntervalMinutes: 15,
    title: 'Delivery Health Dashboard'
  },
  teams: []
};

function readConfig() {
  let config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  // Priority: JIRA_EMAIL env var (Azure App Setting) overrides config.json
  if (process.env.JIRA_EMAIL && process.env.JIRA_EMAIL.trim()) {
    config.jira = config.jira || {};
    config.jira.email = process.env.JIRA_EMAIL.trim();
  }
  return config;
}

function writeConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** Priority: 1) JIRA_API_TOKEN env var (ACI / Azure App Setting), 2) .token file (local dev fallback) */
function getJiraToken() {
  if (process.env.JIRA_API_TOKEN && process.env.JIRA_API_TOKEN.trim()) {
    return process.env.JIRA_API_TOKEN.trim();
  }
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * Persists token to .env file (local dev) and updates process.env immediately.
 * In production, JIRA_API_TOKEN must be set as an Azure App Setting — editing
 * the .env file there is not supported and this function will throw.
 */
function setLocalToken(token) {
  if (process.env.JIRA_API_TOKEN_READONLY === 'true') {
    throw new Error(
      'Token ist als schreibgeschützte Umgebungsvariable gesetzt. ' +
      'Bitte im Azure DevOps Variable Group "vg-infoniqadashboard" ändern und die Pipeline neu starten.'
    );
  }

  // Upsert JIRA_API_TOKEN in .env
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  } catch { /* .env doesn't exist yet */ }

  const key = 'JIRA_API_TOKEN';
  const newLine = `${key}=${token}`;
  const idx = lines.findIndex(l => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    lines.push(newLine);
  }
  try {
    fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');
  } catch {
    // In production containers the .env path is not writable — that's expected.
    // The token is already applied to process.env below.
  }

  // Update the running process immediately (no restart needed)
  process.env.JIRA_API_TOKEN = token;
}

function hasToken() {
  return !!getJiraToken();
}

/**
 * Returns true only when the token is a read-only environment variable
 * (i.e. set via Azure App Setting in production, not via local .env).
 * Set JIRA_API_TOKEN_READONLY=true in ACI to activate the UI lock.
 */
function isTokenFromEnv() {
  return process.env.JIRA_API_TOKEN_READONLY === 'true';
}

module.exports = { readConfig, writeConfig, getJiraToken, setLocalToken, hasToken, isTokenFromEnv };
