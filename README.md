# flow-dashboard-prototype

A clickable **HTML mockup** for a Delivery Health Dashboard — measuring flow metrics, cycle time and predictability across engineering teams. Built as a three-iteration prototype to demonstrate how the dashboard evolves as more data becomes available.

## Live Preview

Open `index.html` in any browser — no server or build step required.

```
open index.html
```

---

## Structure

```
OKR3.2/
├── index.html                  ← Start page & iteration overview
├── dashboard-iteration1.html   ← Iteration 1: Activated & Closed Date only
├── dashboard-iteration2.html   ← Iteration 2: + Work Item Types
└── dashboard-prototype.html    ← Iteration 3: Full data (complete prototype)
```

---

## The Three Iterations

### Iteration 1 — Activated Date & Closed Date

**Minimum data requirement:** only two date fields per work item.

| Field | Source |
|---|---|
| `Activated Date` | When a work item moves to "In Progress" |
| `Closed Date` | When a work item is marked as Done |

**Metrics available:**
- Throughput (items / week) with 12-week sparkline
- Cycle Time P50 / P85 (Closed − Activated)
- WIP count & average age
- Flow Balance (arrival rate ÷ completion rate)
- Cycle Time Scatterplot (90 days)
- WIP Aging Chart

---

### Iteration 2 — + Work Item Type Distribution

Adds **work item type** (User Story, Tech Story, Bug) on top of Iteration 1.

| Field | Source |
|---|---|
| `Activated Date` | Same as Iteration 1 |
| `Closed Date` | Same as Iteration 1 |
| `Work Item Type` ★ | Jira: Issue Type · Azure DevOps: Work Item Type |

**Additional metrics:**
- Capacity on Value Work (non-bug throughput %)
- Work Item Mix bar (US / TS / Bug)
- Net Bug Flow quality chart (stacked created vs. resolved)
- Stacked throughput run chart by type
- Cycle Time Scatter coloured by item type
- Portfolio-level bug prevalence flagging

---

### Iteration 3 — Full Data (Complete Prototype)

Adds **commitment scope** and **scope change tracking** on top of Iteration 2.

| Field | Source |
|---|---|
| `Activated Date` | Same as before |
| `Closed Date` | Same as before |
| `Work Item Type` | Same as before |
| `Commit Tag / Label` ★ | e.g. Label `Q2-2026-committed` in Jira or tag in Azure DevOps |
| `Scope Changes` ★ | Items added to or removed from committed scope after quarter start |

**Additional metrics:**
- Q2 Delivery Progress (done / committed %)
- Pace projection to end of quarter
- On Track / At Risk / Off Track status per team
- Scope change delta tracking (`+added / −removed`)

---

## Dashboard Features

### Portfolio Dashboard (all iterations)
- KPI strip with portfolio-wide aggregated metrics
- Team table sortable by any column
- Business Unit filter
- Info tooltips (ⓘ) explaining every metric

### Team Dashboard (drill-down overlay, all iterations)
- Per-team KPI cards
- WIP Aging Chart (items age vs. P50/P85 thresholds)
- Cycle Time Scatterplot (60 data points, 90-day window)
- Throughput Run Chart (12 weeks)
- Quality / Bug Flow chart (Iteration 2+)

---

## Design Decisions

- **Pure HTML / CSS / Canvas** — zero dependencies, no build tooling
- **Seeded deterministic random** — mock data stays consistent on every reload
- **Responsive layout** — collapses to single-column at < 1024 px
- **Keyboard navigation** — `Esc` closes any team overlay
- **Accessibility** — tooltips positioned dynamically to stay within viewport

---

## Metrics Reference

| Metric | Formula | Threshold |
|---|---|---|
| Throughput | Items closed per week (Closed Date basis) | — |
| Cycle Time P50 | Median of (Closed − Activated) | ↓ = better |
| Cycle Time P85 | 85th percentile of cycle times | ↓ = better |
| Flow Balance | Arrival rate ÷ Completion rate (last 4W) | ≤ 1.1 green · ≤ 1.3 yellow · > 1.3 red |
| Capacity on Value Work | (Total items − Bug-fixes) ÷ Total items | ≥ 75% green · ≥ 60% yellow · < 60% red |
| Q2 Delivery Progress | Done ÷ Committed (scope-tagged items) | ≥ 90% green · ≥ 70% yellow · < 70% red |
