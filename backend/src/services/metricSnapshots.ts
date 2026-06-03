import { getDatabase } from '../database';

type DB = ReturnType<typeof getDatabase>;

export type SnapshotKind = 'matching_run' | 'operator_action' | 'daily' | 'startup';

/**
 * Append one learning-metrics snapshot for a project into `metric_snapshots`.
 *
 * Phase 1 of the learning dashboard: this is the "capture" step. It is purely
 * additive — it READS matching counts and writes one row. It does NOT touch the
 * matcher, the learner, or any existing data, so it cannot cause a matching
 * regression.
 *
 * Internally guarded: it NEVER throws. That lets it be called from inside an
 * operator-action transaction (confirm/reject/analog/manual) and from the
 * matching run without any risk of breaking the user-facing operation.
 */
export function recordMetricSnapshot(
  db: DB,
  projectId: number,
  kind: SnapshotKind,
  actionType: string | null = null,
): void {
  try {
    const total = (db.prepare(
      'SELECT COUNT(*) AS c FROM specification_items WHERE project_id = ?',
    ).get(projectId) as { c: number }).c;

    const matched = (db.prepare(`
      SELECT COUNT(DISTINCT specification_item_id) AS c FROM matched_items
      WHERE specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
    `).get(projectId) as { c: number }).c;

    const confirmed = (db.prepare(`
      SELECT COUNT(DISTINCT specification_item_id) AS c FROM matched_items
      WHERE is_confirmed = 1
        AND specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
    `).get(projectId) as { c: number }).c;

    // Tier composition of the SELECTED match per spec item — same basis as the
    // /api/projects/:id/matching `summary.tierBreakdown`. Stored as JSON so new
    // match types are captured automatically (no hardcoded tier list).
    const tierRows = db.prepare(`
      SELECT match_type, COUNT(DISTINCT specification_item_id) AS c
      FROM matched_items
      WHERE specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
        AND is_selected = 1
      GROUP BY match_type
    `).all(projectId) as { match_type: string; c: number }[];
    const tierBreakdown: Record<string, number> = {};
    for (const r of tierRows) tierBreakdown[r.match_type] = r.c;

    // Global "memory size" indicators — grow as the operator trains the system.
    const learnedSynonyms = (db.prepare(
      "SELECT COUNT(*) AS c FROM construction_synonyms WHERE source = 'learned'",
    ).get() as { c: number }).c;

    // Whole matching-rule base — grows as operator confirmations / manual matches upsert
    // rules. NOTE: operator rules are stored with source='manual' (see
    // upsertPositiveMatchingRule), and matching_rules has no 'seed' source, so filtering
    // by source='learned' would wrongly read 0. Count the entire base.
    const learnedRules = (db.prepare(
      'SELECT COUNT(*) AS c FROM matching_rules',
    ).get() as { c: number }).c;

    db.prepare(`
      INSERT INTO metric_snapshots (
        project_id, kind, action_type, total, matched, confirmed,
        tier_breakdown, learned_synonyms, learned_rules
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId, kind, actionType, total, matched, confirmed,
      JSON.stringify(tierBreakdown), learnedSynonyms, learnedRules,
    );
  } catch (err) {
    // Metrics must never break a user action or a matching run.
    console.error('[metrics] snapshot failed:', err instanceof Error ? err.message : err);
  }
}

/** Snapshot every project at once — used on server startup and the daily heartbeat. */
export function snapshotAllProjects(db: DB, kind: SnapshotKind): void {
  try {
    const projects = db.prepare('SELECT id FROM projects').all() as { id: number }[];
    for (const p of projects) recordMetricSnapshot(db, p.id, kind);
    console.log(`[metrics] ${kind} snapshot recorded for ${projects.length} projects`);
  } catch (err) {
    console.error('[metrics] snapshotAllProjects failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Read the learning-metrics history for a project (Phase 2 read path / Phase 3 dashboard).
 * Returns the NEWEST `limit` snapshots in CHRONOLOGICAL (oldest→newest) order — so a
 * project with more than `limit` snapshots shows its most recent trend, never silently
 * dropping the latest data. Read-only.
 */
export function getMetricsHistory(db: DB, projectId: number, limit = 2000) {
  const capped = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 2000, 1), 10000);
  const rows = db.prepare(`
    SELECT id, created_at, kind, action_type, total, matched, confirmed,
           tier_breakdown, learned_synonyms, learned_rules
    FROM metric_snapshots
    WHERE project_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(projectId, capped) as Array<{
    id: number; created_at: string; kind: string; action_type: string | null;
    total: number; matched: number; confirmed: number;
    tier_breakdown: string | null; learned_synonyms: number; learned_rules: number;
  }>;
  rows.reverse(); // newest `capped` fetched (DESC) → return oldest→newest for the time axis
  return rows.map(r => {
    let tierBreakdown: Record<string, number> = {};
    try { if (r.tier_breakdown) tierBreakdown = JSON.parse(r.tier_breakdown); } catch { /* malformed JSON → {} */ }
    return {
      id: r.id,
      createdAt: r.created_at,
      kind: r.kind,
      actionType: r.action_type,
      total: r.total,
      matched: r.matched,
      confirmed: r.confirmed,
      coverage: r.total > 0 ? Math.round((r.matched / r.total) * 1000) / 10 : 0,
      confirmedPct: r.total > 0 ? Math.round((r.confirmed / r.total) * 1000) / 10 : 0,
      tierBreakdown,
      learnedSynonyms: r.learned_synonyms,
      learnedRules: r.learned_rules,
    };
  });
}

/**
 * All-projects "finish" overview (Phase 6 of the learning dashboard).
 *
 * "Готовность" (readiness toward a finished spec) = confirmed / total — a position is
 * "done" when the operator has CONFIRMED its match; matched-but-unconfirmed still needs an
 * operator decision, so it counts as "осталось до финиша". v1 uses total as the denominator
 * (no exclusion of structurally-unmatchable header rows) and focuses on the TREND, which can
 * go down as well as up (operator re-work, re-upload) — agreed with the owner.
 *
 * The dynamic aggregate trend is derived from the per-project `metric_snapshots` already being
 * captured: walk every snapshot in time order, keep each project's latest (total, confirmed),
 * and emit the running global readiness at each step (a step-function over real events).
 * Read-only.
 */
export function getOverview(db: DB) {
  const rows = db.prepare(`
    SELECT s.project_id AS pid, s.created_at AS createdAt, s.total AS total, s.confirmed AS confirmed,
           p.name AS name
    FROM metric_snapshots s
    LEFT JOIN projects p ON s.project_id = p.id
    ORDER BY s.created_at ASC, s.id ASC
  `).all() as Array<{ pid: number; createdAt: string; total: number; confirmed: number; name: string | null }>;

  const latest: Record<number, { total: number; confirmed: number; name: string | null }> = {};
  let sumTotal = 0, sumConfirmed = 0;
  const series: Array<{ createdAt: string; total: number; confirmed: number; readiness: number }> = [];
  for (const r of rows) {
    const prev = latest[r.pid];
    if (prev) { sumTotal -= prev.total; sumConfirmed -= prev.confirmed; }
    latest[r.pid] = { total: r.total, confirmed: r.confirmed, name: r.name };
    sumTotal += r.total; sumConfirmed += r.confirmed;
    series.push({
      createdAt: r.createdAt,
      total: sumTotal,
      confirmed: sumConfirmed,
      readiness: sumTotal > 0 ? Math.round((sumConfirmed / sumTotal) * 1000) / 10 : 0,
    });
  }

  const byProject = Object.entries(latest).map(([pid, v]) => ({
    id: Number(pid),
    name: v.name || `#${pid}`,
    total: v.total,
    confirmed: v.confirmed,
    remaining: Math.max(0, v.total - v.confirmed),
    readiness: v.total > 0 ? Math.round((v.confirmed / v.total) * 1000) / 10 : 0,
  })).sort((a, b) => b.remaining - a.remaining);

  const total = byProject.reduce((s, p) => s + p.total, 0);
  const confirmed = byProject.reduce((s, p) => s + p.confirmed, 0);

  return {
    current: {
      projects: byProject.length,
      total,
      confirmed,
      remaining: Math.max(0, total - confirmed),
      readiness: total > 0 ? Math.round((confirmed / total) * 1000) / 10 : 0,
      byProject,
    },
    series: series.slice(-5000), // cap response size (CARRY C2: downsample later if needed)
  };
}
