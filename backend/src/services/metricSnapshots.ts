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

    const learnedRules = (db.prepare(
      "SELECT COUNT(*) AS c FROM matching_rules WHERE source = 'learned'",
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
