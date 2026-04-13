'use strict';

const WEEKS = 12;

// ── Category matching ────────────────────────────────────────────────

/**
 * Categorise a raw Jira issue according to workItemCategories config.
 * Returns the matching category object or null.
 *
 * filter.method:
 *   'issueType'   — match by issue type name (case-insensitive). issueTypes[] must contain it.
 *   'label'       — issue.fields.labels must contain labelValue (case-insensitive).
 *   'customField' — issue.fields[customFieldId] must equal customFieldValue (case-insensitive).
 */
function matchCategory(issue, category) {
  const f = category.filter;
  if (!f) return false;
  const issueTypeName = (issue.fields?.issuetype?.name || '').toLowerCase();
  const labels = (issue.fields?.labels || []).map(l => l.toLowerCase());

  switch (f.method) {
    case 'issueType': {
      const types = (f.issueTypes || []).map(t => t.toLowerCase());
      return types.length > 0 && types.includes(issueTypeName);
    }
    case 'label': {
      if (!f.labelValue) return false;
      // Optional: also restrict to certain issue types
      if (f.issueTypes?.length) {
        const types = f.issueTypes.map(t => t.toLowerCase());
        if (!types.includes(issueTypeName)) return false;
      }
      return labels.includes(f.labelValue.toLowerCase());
    }
    case 'customField': {
      if (!f.customFieldId || !f.customFieldValue) return false;
      if (f.issueTypes?.length) {
        const types = f.issueTypes.map(t => t.toLowerCase());
        if (!types.includes(issueTypeName)) return false;
      }
      const fieldVal = issue.fields?.[f.customFieldId];
      const actual = (typeof fieldVal === 'object' ? fieldVal?.value : fieldVal) || '';
      return String(actual).toLowerCase() === f.customFieldValue.toLowerCase();
    }
    default:
      return false;
  }
}

/**
 * Returns the name of the first matching category, or '__other__' if none match.
 */
function categoriseIssue(issue, categories) {
  if (!categories?.length) return null;
  for (const cat of categories) {
    if (matchCategory(issue, cat)) return cat.name;
  }
  return '__other__';
}

// ── Commitment matching ─────────────────────────────────────────────

/**
 * Returns true if the raw Jira issue is "committed" per the commitment config.
 */
function isCommitted(issue, commitment) {
  if (!commitment) return false;
  switch (commitment.method) {
    case 'label': {
      const labels = (issue.fields?.labels || []).map(l => l.toLowerCase());
      return !!(commitment.labelValue && labels.includes(commitment.labelValue.toLowerCase()));
    }
    case 'parentEpic': {
      if (!commitment.epicKey) return false;
      const parentKey = issue.fields?.parent?.key || '';
      return parentKey.toLowerCase() === commitment.epicKey.toLowerCase();
    }
    case 'fixVersion': {
      if (!commitment.fixVersionName) return false;
      const versions = (issue.fields?.fixVersions || []).map(v => v.name?.toLowerCase());
      return versions.includes(commitment.fixVersionName.toLowerCase());
    }
    default:
      return false;
  }
}

/**
 * Build a JQL snippet that selects committed items within a team's scope.
 * Used for Iteration 3 commitment progress.
 */
function buildCommitmentJql(teamJql, commitment) {
  if (!commitment?.method) return null;
  let snippet;
  switch (commitment.method) {
    case 'label':
      if (!commitment.labelValue) return null;
      snippet = `labels = "${commitment.labelValue.replace(/"/g, '\\"')}"`;
      break;
    case 'parentEpic':
      if (!commitment.epicKey) return null;
      snippet = `issueFunction in subtasksOf("key = ${commitment.epicKey}") OR "Epic Link" = ${commitment.epicKey} OR parent = ${commitment.epicKey}`;
      break;
    case 'fixVersion':
      if (!commitment.fixVersionName) return null;
      snippet = `fixVersion = "${commitment.fixVersionName.replace(/"/g, '\\"')}"`;
      break;
    default:
      return null;
  }
  return `(${teamJql}) AND (${snippet})`;
}

/**
 * Derive flow metrics from raw Jira issues + changelog.
 * Returns an object compatible with the dashboard rendering functions.
 */
function calculateTeamMetrics(issues, team, config) {
  const activeStatus = (team.activeStatus || config.jira?.defaultActiveStatus || 'In Progress').toLowerCase();
  const doneStatus   = (team.doneStatus   || config.jira?.defaultDoneStatus   || 'Done').toLowerCase();
  const categories   = config.jira?.workItemCategories || [];
  const commitment   = config.jira?.commitment || null;
  const iteration    = config.dashboard?.iteration || 1;
  const now = new Date();

  // ── Extract dates from changelog ───────────────────────────────────
  const items = issues.map(issue => {
    const histories = issue.changelog?.histories || [];
    let activatedAt = null;
    let closedAt    = null;
    const type = issue.fields?.issuetype?.name || 'Unknown';

    for (const history of histories) {
      for (const item of history.items || []) {
        if (item.field === 'status') {
          const toStatus = (item.toString || '').toLowerCase();
          if (!activatedAt && toStatus === activeStatus) {
            activatedAt = new Date(history.created);
          }
          if (toStatus === doneStatus) {
            closedAt = new Date(history.created);
          }
        }
      }
    }

    // WIP = Vacanti Option C: item must have passed through activeStatus (activatedAt set)
    // AND not yet reached doneStatus (closedAt not set).
    // This correctly excludes items like "CLARIFICATION IN PROGRESS" that never
    // went through the configured activeStatus (e.g. "DEV Development").
    const isWip = !!(activatedAt && !closedAt);

    return {
      key: issue.key,
      type,
      // Category is derived once here so downstream logic is O(1) per item
      category: categoriseIssue(issue, categories),
      // Raw issue reference kept for commitment matching (Iter 3)
      _raw: issue,
      activatedAt,
      closedAt,
      isWip
    };
  });

  // ── Throughput & Arrival by week (last 12 weeks incl. current) ─────
  // ref = now so the last bucket is the ongoing (incomplete) week.
  // The frontend labels it clearly as "current".
  const tp          = buildWeeklyBuckets(items, i => i.closedAt, now, WEEKS);
  const arrivalRate = buildWeeklyBuckets(items, i => i.activatedAt, now, WEEKS);

  const validTp  = tp.filter(v => v >= 0);
  const avgTp    = validTp.length ? round1(validTp.reduce((s, v) => s + v, 0) / validTp.length) : 0;
  const totalDelivered = tp.reduce((s, v) => s + v, 0);

  // ── Cycle Time ─────────────────────────────────────────────────────
  const closedItems = items.filter(i => i.activatedAt && i.closedAt);
  const cycleTimes  = closedItems.map(
    i => (i.closedAt - i.activatedAt) / MS_PER_DAY + 1  // +1 per Vacanti (min 1 day)
  );
  const p50 = round1(percentile(cycleTimes, 50));
  const p85 = round1(percentile(cycleTimes, 85));

  // Recent cycle time: items closed in last 4 weeks
  const fourWeeksAgo = subtractDays(now, 28);
  const recentClosed = closedItems.filter(i => i.closedAt >= fourWeeksAgo);
  const recentCT = recentClosed.map(i => (i.closedAt - i.activatedAt) / MS_PER_DAY + 1);
  const p50recent = recentCT.length >= 3 ? round1(percentile(recentCT, 50)) : p50;
  const p85recent = recentCT.length >= 3 ? round1(percentile(recentCT, 85)) : p85;

  // ── WIP ────────────────────────────────────────────────────────────
  const wipItems  = items.filter(i => i.isWip);
  const wipAges   = wipItems.map(i => (now - i.activatedAt) / MS_PER_DAY);
  const avgWipAge = wipAges.length ? round1(wipAges.reduce((s, v) => s + v, 0) / wipAges.length) : 0;

  // ── Flow Balance (last 4 weeks) ────────────────────────────────────
  const activated4w = items.filter(i => i.activatedAt && i.activatedAt >= fourWeeksAgo).length;
  const closed4w    = items.filter(i => i.closedAt    && i.closedAt    >= fourWeeksAgo).length;
  const flowRatio   = closed4w > 0
    ? Math.round((activated4w / closed4w) * 100) / 100
    : (activated4w > 0 ? 9.99 : 1.00);

  // ── Throughput Trend ───────────────────────────────────────────────
  const last4wAvg = tp.slice(-4).reduce((s, v) => s + v, 0) / 4;
  const prev4wAvg = tp.slice(-8, -4).reduce((s, v) => s + v, 0) / 4;
  const trendPct  = prev4wAvg > 0 ? Math.round(((last4wAvg - prev4wAvg) / prev4wAvg) * 100) : 0;
  const trend     = trendPct >= 6 ? 'up' : trendPct <= -6 ? 'down' : 'flat';

  // Average arrival rate
  const validArr = arrivalRate.filter(v => v >= 0);
  const avgArrival = validArr.length ? round1(validArr.reduce((s, v) => s + v, 0) / validArr.length) : 0;

  // ── Scatter data for drill-down (last 90 days, closed items) ──────
  const ninetyDaysAgo = subtractDays(now, 90);
  const scatterData = closedItems
    .filter(i => i.closedAt >= ninetyDaysAgo)
    .map(i => ({
      key: i.key,
      x: Math.round((now - i.closedAt) / MS_PER_DAY),
      y: round1((i.closedAt - i.activatedAt) / MS_PER_DAY + 1),
      type: i.type,
      category: i.category
    }));

  // ── WIP Aging data for drill-down ─────────────────────────────────
  const wipAgingData = wipItems
    .map(i => ({
      key: i.key,
      age: Math.round((now - i.activatedAt) / MS_PER_DAY) + 1,
      type: i.type,
      category: i.category
    }))
    .sort((a, b) => b.age - a.age)
    .slice(0, 30);

  // ── Iteration 2: Work Item Mix & Capacity Metrics ─────────────────
  let iter2 = null;
  if (iteration >= 2 && categories.length > 0) {
    const closed4wItems = closedItems.filter(i => i.closedAt >= fourWeeksAgo);
    const wip4wItems    = wipItems;

    // Work item mix: per category — % of 4W throughput
    const mixMap = {};
    for (const cat of categories) mixMap[cat.name] = 0;
    mixMap['__other__'] = 0;

    for (const item of closed4wItems) {
      const key = item.category || '__other__';
      if (!(key in mixMap)) mixMap[key] = 0;
      mixMap[key]++;
    }

    const totalClosed4w = closed4wItems.length || 1;
    const workItemMix = Object.entries(mixMap)
      .filter(([, v]) => v > 0)
      .map(([name, count]) => {
        const catDef = categories.find(c => c.name === name);
        return {
          name,
          count,
          pct: Math.round((count / totalClosed4w) * 100),
          color: catDef?.color || '#9ca3af',
          isValueWork: catDef?.isValueWork ?? true
        };
      });

    // Throughput stacked by category (last 12 weeks)
    const stackedTp = {};
    for (const cat of categories) {
      stackedTp[cat.name] = buildWeeklyBuckets(items, i => i.closedAt, now, WEEKS,
        i => i.category === cat.name);
    }

    // Capacity on value work (last 4 weeks)
    const valueWorkCount = closed4wItems.filter(i => {
      const catDef = categories.find(c => c.name === i.category);
      return catDef?.isValueWork ?? true;
    }).length;
    const capacityOnValueWork = totalClosed4w > 0
      ? Math.round((valueWorkCount / totalClosed4w) * 100) : 0;

    // Net bug flow: items in non-value-work categories activated vs closed last 4w
    const bugCategories = new Set(
      categories.filter(c => !c.isValueWork).map(c => c.name)
    );
    const bugsActivated4w = items.filter(i =>
      i.activatedAt && i.activatedAt >= fourWeeksAgo && bugCategories.has(i.category)
    ).length;
    const bugsClosed4w = closed4wItems.filter(i => bugCategories.has(i.category)).length;
    const netBugFlow = bugsActivated4w - bugsClosed4w;

    iter2 = { workItemMix, stackedTp, capacityOnValueWork, netBugFlow, bugsActivated4w, bugsClosed4w };
  }

  // ── Iteration 3: Commitment Progress ──────────────────────────────
  let iter3 = null;
  if (iteration >= 3 && commitment) {
    const quarterStart = commitment.quarterStart ? new Date(commitment.quarterStart) : null;
    const quarterEnd   = commitment.quarterEnd   ? new Date(commitment.quarterEnd)   : null;

    const committedItems = items.filter(i => isCommitted(i._raw, commitment));
    const committedDone  = committedItems.filter(i => i.closedAt != null);

    let paceStatus = 'unknown';
    let paceProjected = null;
    if (quarterStart && quarterEnd) {
      const totalWeeks  = Math.max(1, (quarterEnd - quarterStart) / (7 * MS_PER_DAY));
      const weeksElapsed = Math.max(0.5, (now - quarterStart) / (7 * MS_PER_DAY));
      const weeklyPace  = committedDone.length / weeksElapsed;
      paceProjected     = Math.round(weeklyPace * totalWeeks);
      const projPct     = committedItems.length > 0
        ? (paceProjected / committedItems.length) * 100 : 0;
      paceStatus = projPct >= 90 ? 'on-track' : projPct >= 70 ? 'at-risk' : 'off-track';
    }

    iter3 = {
      committed:      committedItems.length,
      done:           committedDone.length,
      paceProjected,
      paceStatus
    };
  }

  return {
    // Throughput
    avgTp,
    tp,
    arrivalRate,
    avgArrival,
    totalDelivered,

    // Cycle time
    p50,
    p85,
    p50recent,
    p85recent,

    // WIP
    wipCount: wipItems.length,
    wipAvgAge: avgWipAge,

    // Flow
    flowRatio,
    activated4w,
    closed4w,

    // Trend
    trendPct,
    trend,

    // Drill-down
    scatterData,
    wipAgingData,

    // Iter 2
    ...(iter2 || {}),

    // Iter 3
    ...(iter3 ? { commitmentProgress: iter3 } : {}),

    // Meta
    tool: 'Jira Cloud',
    totalIssuesFetched: issues.length,
    issueTypesFiltered: [...new Set(items.map(i => i.type))].sort()
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function startOfIsoWeek(date) {
  const d = new Date(date);
  const day = d.getDay() || 7; // Mon=1 … Sun=7
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (day - 1));
  return d;
}

function buildWeeklyBuckets(items, dateFn, ref, weeks, filterFn = null) {
  const result = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = subtractDays(ref, (w + 1) * 7);
    const end   = subtractDays(ref, w * 7);
    const count = items.filter(i => {
      const d = dateFn(i);
      return d && d >= start && d < end && (!filterFn || filterFn(i));
    }).length;
    result.push(count);
  }
  return result;
}

function subtractDays(date, days) {
  return new Date(date.getTime() - days * MS_PER_DAY);
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx    = (p / 100) * (sorted.length - 1);
  const lo     = Math.floor(idx);
  const hi     = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

module.exports = { calculateTeamMetrics, buildCommitmentJql };
