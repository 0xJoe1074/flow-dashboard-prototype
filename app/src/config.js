'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../data/config.json');
const TOKEN_PATH  = path.join(__dirname, '../data/.token');

const DEFAULT_CONFIG = {
  jira: {
    baseUrl: 'https://infoniqa.atlassian.net',
    email: '',
    defaultActiveStatus: 'In Progress',
    defaultDoneStatus: 'Done'
  },
  dashboard: {
    iteration: 1,
    refreshIntervalMinutes: 15,
    title: 'Delivery Health Dashboard'
  },
  teams: []
};

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function writeConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** Priority: 1) JIRA_API_TOKEN env var (Azure App Setting), 2) .token file (local dev) */
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

/** Persists token to .token file. Throws if overridden by env var. */
function setLocalToken(token) {
  if (process.env.JIRA_API_TOKEN && process.env.JIRA_API_TOKEN.trim()) {
    throw new Error(
      'Token ist als Umgebungsvariable gesetzt (z.B. Azure App Setting). ' +
      'Bitte dort ändern — nicht über die Admin-UI.'
    );
  }
  const dir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, token, 'utf-8');
}

function hasToken() {
  return !!getJiraToken();
}

function isTokenFromEnv() {
  return !!(process.env.JIRA_API_TOKEN && process.env.JIRA_API_TOKEN.trim());
}

module.exports = { readConfig, writeConfig, getJiraToken, setLocalToken, hasToken, isTokenFromEnv };
