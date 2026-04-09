'use strict';

const WEEKS = 12;

/**
 * Derive flow metrics from raw Jira issues + changelog.
 * Returns an object compatible with the dashboard rendering functions.
 */
function calculateTeamMetrics(issues, team, config) {
  const activeStatus = (team.activeStatus || config.jira?.defaultActiveStatus || 'In Progress').toLowerCase();
  const doneStatus   = (team.doneStatus   || config.jira?.defaultDoneStatus   || 'Done').toLowerCase();
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

    return {
      key: issue.key,
      type,
      activatedAt,
      closedAt,
      isWip: !!(activatedAt && !closedAt)
    };
  });

  // ── Throughput & Arrival by week (last 12 weeks) ───────────────────
  const tp          = buildWeeklyBuckets(items, i => i.closedAt, now, WEEKS);
  const arrivalRate = buildWeeklyBuckets(items, i => i.activatedAt, now, WEEKS);

  const validTp  = tp.filter(v => v >= 0);
  const avgTp    = validTp.length ? round1(validTp.reduce((s, v) => s + v, 0) / validTp.length) : 0;
  const totalDelivered = tp.reduce((s, v) => s + v, 0);

  // ── Cycle Time ─────────────────────────────────────────────────────
  const closedItems = items.filter(i => i.activatedAt && i.closedAt);
  const cycleTimes  = closedItems.map(
    i => (i.closedAt - i.activatedAt) / MS_PER_DAY
  );
  const p50 = round1(percentile(cycleTimes, 50));
  const p85 = round1(percentile(cycleTimes, 85));

  // Recent cycle time: items closed in last 4 weeks
  const fourWeeksAgo = subtractDays(now, 28);
  const recentClosed = closedItems.filter(i => i.closedAt >= fourWeeksAgo);
  const recentCT = recentClosed.map(i => (i.closedAt - i.activatedAt) / MS_PER_DAY);
  const p50recent = recentCT.length >= 3 ? round1(percentile(recentCT, 50)) : p50;

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
      x: Math.round((now - i.closedAt) / MS_PER_DAY),
      y: round1((i.closedAt - i.activatedAt) / MS_PER_DAY),
      type: i.type
    }));

  // ── WIP Aging data for drill-down ─────────────────────────────────
  const wipAgingData = wipItems
    .map(i => ({
      key: i.key,
      age: Math.round((now - i.activatedAt) / MS_PER_DAY),
      type: i.type
    }))
    .sort((a, b) => b.age - a.age)
    .slice(0, 30);

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

    // WIP
    wipCount: wipItems.length,
    wipAvgAge,

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

    // Meta
    tool: 'Jira Cloud',
    totalIssuesFetched: issues.length
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function buildWeeklyBuckets(items, dateFn, now, weeks) {
  const result = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = subtractDays(now, (w + 1) * 7);
    const end   = subtractDays(now, w * 7);
    const count = items.filter(i => {
      const d = dateFn(i);
      return d && d >= start && d < end;
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

module.exports = { calculateTeamMetrics };
