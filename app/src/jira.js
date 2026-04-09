'use strict';

const BATCH_SIZE = 100;

/**
 * Low-level Jira Cloud REST v3 fetch.
 * Throws on non-2xx responses.
 */
async function jiraFetch(apiPath, jiraConfig, token, options = {}) {
  const url = `${jiraConfig.baseUrl}/rest/api/3${apiPath}`;
  const auth = Buffer.from(`${jiraConfig.email}:${token}`).toString('base64');

  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jira API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Verify credentials & token — returns { ok, user } or { ok: false, error } */
async function testConnection(jiraConfig, token) {
  try {
    const data = await jiraFetch('/myself', jiraConfig, token);
    return { ok: true, user: data.displayName || data.emailAddress };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Fetch all Scrum/Kanban boards the user has access to.
 * Uses the Agile REST API v1.
 * Returns [{ id, name, type, projectKey, projectName, jql }]
 */
async function getBoards(jiraConfig, token) {
  const results = [];
  let startAt = 0;
  let total = Infinity;

  while (startAt < total) {
    const qs = new URLSearchParams({ startAt, maxResults: 50, type: 'scrum,kanban' });
    const url = `${jiraConfig.baseUrl}/rest/agile/1.0/board?${qs}`;
    const auth = Buffer.from(`${jiraConfig.email}:${token}`).toString('base64');
    const res  = await fetch(url, {
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
    });
    if (!res.ok) break;
    const data = await res.json();
    total = data.total ?? 0;
    const values = data.values || [];
    values.forEach(b => {
      const projectKey  = b.location?.projectKey  || null;
      const projectName = b.location?.projectName || null;
      results.push({
        id:          b.id,
        name:        b.name,
        type:        b.type,
        projectKey,
        projectName,
        // Auto-generate a sensible JQL — can be edited in the team form
        jql: projectKey
          ? `project = ${projectKey} AND issuetype in standardIssueTypes() ORDER BY updated DESC`
          : `filter = "${b.name}" ORDER BY updated DESC`
      });
    });
    startAt += values.length;
    if (values.length === 0) break;
  }
  return results;
}

/** Returns all global Jira statuses as [{ id, name, category }] */
async function getStatuses(jiraConfig, token) {
  const data = await jiraFetch('/status', jiraConfig, token);
  return data.map(s => ({
    id: s.id,
    name: s.name,
    category: s.statusCategory?.name || 'unknown'
  }));
}

/**
 * Fetch all issues matching the team JQL updated in the last 90 days,
 * with changelog expanded (for Activated/Closed date extraction).
 * Paginates automatically in batches of 100.
 */
async function fetchTeamIssues(team, jiraConfig, token) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const dateStr = cutoff.toISOString().split('T')[0];

  const jql = `(${team.jql}) AND updated >= "${dateStr}" ORDER BY updated DESC`;
  const fields = 'summary,status,issuetype,created,updated';

  let allIssues = [];
  let startAt = 0;
  let total = Infinity;

  while (startAt < total) {
    const qs = new URLSearchParams({
      jql,
      startAt,
      maxResults: BATCH_SIZE,
      fields,
      expand: 'changelog'
    });
    const data = await jiraFetch(`/search/jql?${qs}`, jiraConfig, token);
    total = data.total ?? 0;
    const batch = data.issues || [];
    allIssues = allIssues.concat(batch);
    startAt += batch.length;
    if (batch.length === 0) break;
  }

  return allIssues;
}

/**
 * Preview: returns the count of issues matching a JQL string.
 * Used by Admin UI for the JQL preview button.
 */
async function previewJql(jql, jiraConfig, token) {
  const qs = new URLSearchParams({ jql, maxResults: 1, fields: 'summary' });
  const data = await jiraFetch(`/search/jql?${qs}`, jiraConfig, token);
  return data.total ?? 0;
}

module.exports = { jiraFetch, testConnection, getStatuses, getBoards, fetchTeamIssues, previewJql };
