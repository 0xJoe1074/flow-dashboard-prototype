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

All metrics, their formulas, and how to interpret them.

---

### Throughput

**Available from:** Iteration 1

| | |
|---|---|
| **Formula** | Count of items where `Closed Date` falls within the calendar week |
| **Unit** | Items / week |
| **Sparkline** | 12-week history; trend arrow = avg last 4W vs. avg previous 4W |
| **Portfolio KPI** | % change: `(avg last 2W − avg 12W baseline) ÷ avg 12W baseline` |
| **Interpretation** | Higher = better. A rising trend (green) means the team is accelerating. A falling trend (red) may indicate impediments, team changes, or growing WIP. |

---

### Cycle Time P50 (Median)

**Available from:** Iteration 1

| | |
|---|---|
| **Formula** | `Closed Date − Activated Date` for each item; 50th percentile of the distribution |
| **Unit** | Days |
| **Trend** | `Avg P50 last 2W − Avg P50 12W baseline` |
| **Interpretation** | Lower = better. P50 is the "typical" delivery time — half of all items are delivered faster than this. A negative trend delta (green) means items are flowing through faster. |

---

### Cycle Time P85

**Available from:** Iteration 1

| | |
|---|---|
| **Formula** | `P50 × team-specific ratio` (ratio derived from historical spread; approximates 85th percentile) |
| **Unit** | Days |
| **Interpretation** | The "worst common case" — 85% of items complete within this time. Use P85 as a realistic SLA for stakeholder commitments. Significant gap between P50 and P85 indicates high variability. |

---

### Cycle Time P95

**Available from:** Iteration 1 (Scatterplot only)

| | |
|---|---|
| **Formula** | `P85 × 1.3` |
| **Unit** | Days |
| **Interpretation** | Outlier boundary shown in the scatterplot. Items above P95 are exceptions warranting individual investigation. Not used in table or KPI strip. |

---

### WIP (Work In Progress) Count

**Available from:** Iteration 1

| | |
|---|---|
| **Formula** | Count of items with `Activated Date` set and no `Closed Date` |
| **Unit** | Items |
| **Interpretation** | Lower is generally healthier. High WIP relative to throughput increases average cycle time (Little's Law: `Avg CT = WIP ÷ Throughput`). |

---

### WIP Average Age

**Available from:** Iteration 1

| | |
|---|---|
| **Formula** | `Today − Activated Date` per open item; then averaged across all open items |
| **Unit** | Days |
| **Threshold** | Avg Age `< P50` → green (fresh) · `< 1.3 × P50` → yellow (normal) · `≥ 1.3 × P50` → red (aged) |
| **Interpretation** | If the average age of open items exceeds the P50 cycle time, work is stalling. The WIP Aging Chart shows individual items against P50/P85 reference lines. |

---

### Flow Balance (Arrival Rate ÷ Completion Rate)

**Available from:** Iteration 1

| | |
|---|---|
| **Formula** | `(Items activated in last 4W ÷ 4) ÷ (Items closed in last 4W ÷ 4)` |
| **Unit** | Ratio (×) |
| **Threshold** | ≤ 1.1× → green (stable) · ≤ 1.3× → yellow (WIP growing slightly) · > 1.3× → red (WIP growing critically) |
| **Interpretation** | 1.0 = perfectly balanced. Ratio > 1 means more work enters the system than leaves — WIP accumulates over time and future cycle times will lengthen. The Flow Balance chart shows grouped bars (arrivals up, completions down) plus a cumulative net WIP line. |

---

### Capacity on Value Work

**Available from:** Iteration 2

| | |
|---|---|
| **Formula** | `(Total items closed − Bug-fix items closed) ÷ Total items closed` |
| **Unit** | % |
| **Threshold** | ≥ 75% → green · ≥ 60% → yellow · < 60% → red |
| **Interpretation** | Measures what fraction of a team's throughput goes to feature/improvement work (User Stories + Tech Stories) vs. reactive bug fixing. A low value signals a quality debt problem that consumes capacity intended for product development. |

---

### Work Item Mix

**Available from:** Iteration 2

| | |
|---|---|
| **Formula** | `User Story %`, `Tech Story %`, `Bug %` each = type count ÷ total closed items |
| **Unit** | % per type (stacked to 100%) |
| **Interpretation** | Shows the decomposition of throughput. A healthy mix depends on team context, but a rising Bug% over time indicates accumulating quality debt. Visible per team in the table bar and as a stacked run chart in the team overlay. |

---

### Net Bug Flow

**Available from:** Iteration 2

| | |
|---|---|
| **Formula** | Weekly: `Bugs created − Bugs resolved`. Cumulative: running sum of weekly net |
| **Unit** | Items (delta) |
| **Threshold** | Cumulative line trending down (green) = resolving faster than creating. Trending up (red) = quality debt accumulating. |
| **Interpretation** | A cumulative net of 0 or below means the team is keeping up with or reducing its bug backlog. A rising cumulative line is an early warning of quality issues before they visibly hurt throughput. |

---

### Q2 Delivery Progress

**Available from:** Iteration 3

| | |
|---|---|
| **Formula** | `Done ÷ Committed` where *committed* = items tagged `Q2-2026-committed` |
| **Unit** | % |
| **Interpretation** | Absolute progress against the committed scope at the start of the quarter. Does not account for time remaining. |

---

### Pace Projection

**Available from:** Iteration 3

| | |
|---|---|
| **Formula** | `(Done ÷ Weeks elapsed) × 13` — projects current delivery rate across the full 13-week quarter |
| **Unit** | % of committed scope |
| **Threshold** | Projected ≥ 90% → **On Track** (green) · ≥ 70% → **At Risk** (yellow) · < 70% → **Off Track** (red) |
| **Interpretation** | Forward-looking signal. A team can be at 50% done after 8 weeks and still be On Track if pace is sufficient. Updates every week as more items close. |

---

### Scope Change Delta

**Available from:** Iteration 3

| | |
|---|---|
| **Formula** | `+N added` (items tagged after quarter start) · `−N removed` (items de-scoped) |
| **Unit** | Item count |
| **Interpretation** | Frequent positive scope changes without removing other items inflate the committed scope mid-quarter and distort Delivery Progress. A `+added` count greater than `−removed` is a scope creep signal.
