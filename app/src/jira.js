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
  const auth = Buffer.from(`${jiraConfig.email}:${token}`).toString('base64');
  const baseUrl = jiraConfig.baseUrl;

  // Helper: fetch board configuration (contains saved filter id + jql)
  async function getBoardFilterJql(boardId) {
    try {
      const cfgRes = await fetch(`${baseUrl}/rest/agile/1.0/board/${boardId}/configuration`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
      });
      if (!cfgRes.ok) return null;
      const cfg = await cfgRes.json();
      const filterId = cfg.filter?.id;
      if (!filterId) return null;

      // Fetch the actual JQL from the filter
      const fRes = await fetch(`${baseUrl}/rest/api/3/filter/${filterId}`, {
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
      });
      if (!fRes.ok) return null;
      const f = await fRes.json();
      // Strip ORDER BY clause — it causes issues with our metric queries
      return (f.jql || '').replace(/\s+order\s+by\s+.+$/i, '').trim() || null;
    } catch {
      return null;
    }
  }

  const results = [];
  let startAt = 0;
  let total = Infinity;

  while (startAt < total) {
    const qs = new URLSearchParams({ startAt, maxResults: 50, type: 'scrum,kanban' });
    const res = await fetch(`${baseUrl}/rest/agile/1.0/board?${qs}`, {
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
    });
    if (!res.ok) break;
    const data = await res.json();
    total = data.total ?? 0;
    const values = data.values || [];

    // Fetch filter JQL for all boards in this page in parallel
    const filterJqls = await Promise.all(values.map(b => getBoardFilterJql(b.id)));

    values.forEach((b, i) => {
      const projectKey  = b.location?.projectKey  || null;
      const projectName = b.location?.projectName || null;
      // Prefer the board's own saved filter JQL; fall back to project JQL
      const jql = filterJqls[i]
        || (projectKey ? `project = ${projectKey}` : `project in projectsFromBoard(${b.id})`);
      results.push({ id: b.id, name: b.name, type: b.type, projectKey, projectName, jql });
    });

    startAt += values.length;
    if (values.length === 0) break;
  }
  return results;
}

/** Returns all global Jira statuses as [{ id, name, category }], deduplicated by name */
async function getStatuses(jiraConfig, token) {
  const data = await jiraFetch('/status', jiraConfig, token);
  const seen = new Map();
  for (const s of data) {
    const key = s.name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, {
        id: s.id,
        name: s.name,
        category: s.statusCategory?.name || 'unknown'
      });
    }
  }
  return [...seen.values()];
}

/** Returns all non-subtask issue types as [{ id, name }] deduplicated by name, sorted */
async function getIssueTypes(jiraConfig, token) {
  const data = await jiraFetch('/issuetype', jiraConfig, token);
  const seen = new Map();
  for (const t of data) {
    if (!t.subtask && !seen.has(t.name)) {
      seen.set(t.name, { id: t.id, name: t.name });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fetch all issues matching the team JQL updated in the last 90 days,
 * with changelog expanded (for Activated/Closed date extraction).
 * Paginates automatically in batches of 100.
 */
async function fetchTeamIssues(team, jiraConfig, token, customFieldIds = []) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const dateStr = cutoff.toISOString().split('T')[0];

  // Apply issue type filter: team-level overrides global; empty/null = all types
  const effectiveTypes = team.issueTypes?.length
    ? team.issueTypes
    : (jiraConfig.defaultIssueTypes?.length ? jiraConfig.defaultIssueTypes : null);

  // Fetch recent items (90 days) for throughput/cycle time metrics,
  // PLUS all items currently in an active status (regardless of age) so
  // stale WIP is never missed.
  let jql = `(${team.jql}) AND (updated >= "${dateStr}" OR statusCategory = "In Progress")`;
  if (effectiveTypes?.length) {
    const quoted = effectiveTypes.map(t => `"${t.replace(/"/g, '\\"')}"`).join(', ');
    jql += ` AND issuetype in (${quoted})`;
  }
  const extraFields = (customFieldIds || []).filter(Boolean);
  const fields = ['summary', 'status', 'issuetype', 'created', 'updated',
    'labels', 'fixVersions', 'parent', ...extraFields].join(',');

  let allIssues = [];
  // Support both legacy (total/startAt) and new (nextPageToken/isLast) pagination
  let startAt = 0;
  let nextPageToken = null;
  let isLast = false;
  let total = Infinity;

  while (!isLast && allIssues.length < total) {
    const params = {
      jql,
      maxResults: BATCH_SIZE,
      fields,
      expand: 'changelog'
    };
    if (nextPageToken) {
      params.nextPageToken = nextPageToken;
    } else {
      params.startAt = startAt;
    }
    const qs = new URLSearchParams(params);
    const data = await jiraFetch(`/search/jql?${qs}`, jiraConfig, token);

    const batch = data.issues || [];
    allIssues = allIssues.concat(batch);

    // New API: isLast / nextPageToken
    if (typeof data.isLast === 'boolean') {
      isLast = data.isLast;
      nextPageToken = data.nextPageToken || null;
      // Safety: if no nextPageToken and not explicitly isLast, treat as last page
      if (!nextPageToken) isLast = true;
    } else {
      // Legacy API: total / startAt
      total = data.total ?? 0;
      startAt += batch.length;
      isLast = startAt >= total;
    }

    if (batch.length === 0) break;
  }

  // Strip non-status changelog entries to minimise memory usage.
  // calculateTeamMetrics() only reads history items where field === 'status',
  // so assignment-, priority-, label- and comment-changes are pure overhead.
  for (const issue of allIssues) {
    if (issue.changelog?.histories) {
      issue.changelog.histories = issue.changelog.histories
        .filter(h => h.items?.some(i => i.field === 'status'))
        .map(h => ({
          created: h.created,
          items: h.items.filter(i => i.field === 'status')
        }));
    }
  }

  return allIssues;
}

/**
 * Fetch distinct statuses actually used by issues matching a JQL.
 * Samples up to 200 recent issues and collects unique status names + categories.
 * Returns [{ name, category }] sorted by category priority then name.
 */
async function getStatusesForJql(jql, jiraConfig, token) {
  const qs = new URLSearchParams({ jql, maxResults: 200, fields: 'status' });
  const data = await jiraFetch(`/search/jql?${qs}`, jiraConfig, token);
  const seen = new Map();
  for (const issue of data.issues || []) {
    const s = issue.fields?.status;
    if (s && !seen.has(s.name)) {
      seen.set(s.name, {
        name:     s.name,
        category: s.statusCategory?.name || 'unknown'
      });
    }
  }
  const CATEGORY_ORDER = { 'In Progress': 0, 'Done': 1, 'To Do': 2 };
  return [...seen.values()].sort((a, b) => {
    const ca = CATEGORY_ORDER[a.category] ?? 9;
    const cb = CATEGORY_ORDER[b.category] ?? 9;
    return ca !== cb ? ca - cb : a.name.localeCompare(b.name);
  });
}

/**
 * Preview: returns the count of issues matching a JQL string.
 * Used by Admin UI for the JQL preview button.
 */
async function previewJql(jql, jiraConfig, token) {
  const qs = new URLSearchParams({ jql, maxResults: 1, fields: 'summary' });
  const data = await jiraFetch(`/search/jql?${qs}`, jiraConfig, token);
  // New API returns isLast instead of total — fall back to issue count
  if (typeof data.total === 'number') return data.total;
  // If isLast=true and we got 0 issues → 0; otherwise unknown, return fetched count
  return (data.issues?.length ?? 0);
}

/**
 * Fetch available Labels from Jira (paginated, up to 1000).
 * Returns string[] sorted alphabetically.
 */
async function getLabels(jiraConfig, token) {
  const labels = [];
  let startAt = 0;
  let total = Infinity;
  while (labels.length < total) {
    const qs = new URLSearchParams({ startAt, maxResults: 200 });
    const data = await jiraFetch(`/label?${qs}`, jiraConfig, token);
    const values = data.values || [];
    labels.push(...values);
    total = typeof data.total === 'number' ? data.total : values.length;
    startAt += values.length;
    if (values.length === 0 || startAt >= total) break;
    if (labels.length >= 1000) break; // safety cap
  }
  return labels.sort((a, b) => a.localeCompare(b));
}

/**
 * Fetch all custom fields from Jira.
 * Returns [{ id, name }] sorted by name.
 */
async function getCustomFields(jiraConfig, token) {
  const data = await jiraFetch('/field', jiraConfig, token);
  return (data || [])
    .filter(f => f.custom === true)
    .map(f => ({ id: f.id, name: f.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { jiraFetch, testConnection, getStatuses, getIssueTypes, getStatusesForJql, getBoards, fetchTeamIssues, previewJql, getLabels, getCustomFields };
