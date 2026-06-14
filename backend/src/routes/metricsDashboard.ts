import { Router, Request, Response } from 'express';
import { getDatabase } from '../database';

/**
 * GET /api/metrics/dashboard
 *
 * Per worker_brief_2026-06-14_metrics_dashboard_v1.md §2.1 + fixes §2.2-2.3:
 * returns an aggregate snapshot per live project for the 5-card minimal
 * dashboard. The cards are intentionally derived from the same numbers an
 * operator would compute by hand from `GET /api/projects/:id/matching` — i.e.
 * `with_any_candidate` mirrors `summary.matched` from that endpoint,
 * `operator_confirmed` mirrors `summary.confirmed`. The dashboard is just a
 * quick cross-project view, not a new source of truth.
 *
 * Top-1 = the row with is_selected=1 (matcher's own tie-break: dnScore →
 * quantityScore → confidence, see matching.ts:486-494). Fallback to highest
 * confidence then lowest id when no match is flagged selected (e.g. legacy
 * rows from before the is_selected column existed). This mirrors the existing
 * tierBreakdown query in /matching (matching.ts:741-747) and makes the
 * dashboard agree row-for-row with the prod UI's "first variant".
 *
 * `accuracy_at_1_status === 'tautology'` is hard-coded in this version because
 * the matching endpoint hides rivals for confirmed matches, so any naive
 * measurement returns 100%. An honest measurement is a separate ticket (В1.2 in
 * the plan). The card on the frontend shows "честное число позже" for now.
 *
 * Filtering (worker_brief_2026-06-14_dashboard_visibility_flag §3.3):
 * a project shows on the dashboard when it is flagged
 * `show_on_dashboard = 1` AND has at least one spec row (`spec_total > 0`).
 * This replaced the earlier fragile heuristic (spec_total > 100 AND signal),
 * which let test projects leak in. The flag is owner-controlled per project
 * (NO hard-coded id list — feedback_no_hardcode); DEFAULT 1 means everything
 * stays visible until the owner hides a project with the toggle button.
 * `?includeHidden=1` returns all projects with spec_total > 0 (hidden ones
 * too) so the owner can un-hide them.
 *
 * 60-second TTL cache keeps the page responsive when reloaded in quick
 * succession (a single SQL pass for all 4 projects already runs well under 2s,
 * so this is a safety net rather than a necessity). The cache is keyed by the
 * includeHidden flag and is invalidated by invalidateDashboardCache() when a
 * project's visibility is toggled, so the change is visible immediately.
 */

const router = Router();

interface ProjectMetrics {
  project_id: number;
  project_name: string;
  spec_total: number;
  with_any_candidate: number;
  without_candidate: number;
  memory_top1: number;
  llm_top1: number;
  name_sim_top1: number;
  manual_top1: number;
  exact_article_top1: number;
  name_characteristics_top1: number;
  operator_confirmed: number;
  accuracy_at_1_status: 'tautology' | 'honest' | 'n/a';
  accuracy_at_1_value: number | null;
  show_on_dashboard: number;
}

const TTL_MS = 60_000;
// Cache is keyed by the includeHidden flag — the two views return different
// row sets, so they must not share one cache slot.
const cache: Record<'default' | 'all', { at: number; data: ProjectMetrics[] } | null> = {
  default: null,
  all: null,
};

function computeMetrics(includeHidden: boolean): ProjectMetrics[] {
  const db = getDatabase();

  // One pass per project so we can apply the visibility filter at the end
  // without having to re-scan. Inside each project we use a single query to
  // compute the top-1 match_type per spec_item (top-1 = is_selected=1, fallback
  // by confidence — see the top1Stmt comment below).
  const projects = db
    .prepare('SELECT id, name, show_on_dashboard FROM projects ORDER BY id')
    .all() as Array<{ id: number; name: string; show_on_dashboard: number }>;

  const out: ProjectMetrics[] = [];

  // Pre-compile queries once (better-sqlite3 statement caching).
  const totalStmt = db.prepare(
    'SELECT COUNT(*) AS cnt FROM specification_items WHERE project_id = ?'
  );

  // with_any_candidate / without_candidate / operator_confirmed:
  // count spec_items by whether they have any match / any confirmed match.
  // Uses EXISTS for cheap short-circuit evaluation per spec row.
  const coverageStmt = db.prepare(`
    SELECT
      COUNT(*) AS spec_total,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM matched_items m WHERE m.specification_item_id = si.id
      ) THEN 1 ELSE 0 END) AS with_any_candidate,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM matched_items m
        WHERE m.specification_item_id = si.id AND m.is_confirmed = 1
      ) THEN 1 ELSE 0 END) AS operator_confirmed
    FROM specification_items si
    WHERE si.project_id = ?
  `);

  // top-1 match_type per spec_item, grouped:
  // For each spec_item, take the match flagged is_selected=1 by the matcher
  // (which uses dnScore → quantityScore → confidence as the tie-break, see
  // matching.ts:486-494). Fallback to highest confidence then lowest id when
  // nothing is selected (defensive — covers legacy rows or unusual states).
  // This mirrors the tierBreakdown query in /matching (matching.ts:741-747)
  // so the dashboard agrees row-for-row with the prod UI's "first variant".
  const top1Stmt = db.prepare(`
    SELECT match_type, COUNT(*) AS cnt
    FROM (
      SELECT m.match_type
      FROM matched_items m
      INNER JOIN specification_items si ON m.specification_item_id = si.id
      WHERE si.project_id = ?
        AND m.id = (
          SELECT m2.id FROM matched_items m2
          WHERE m2.specification_item_id = m.specification_item_id
          ORDER BY m2.is_selected DESC, m2.confidence DESC, m2.id ASC
          LIMIT 1
        )
    ) AS top1
    GROUP BY match_type
  `);

  for (const p of projects) {
    const total = totalStmt.get(p.id) as { cnt: number };
    const specTotal = total.cnt;

    // skip silent empties before doing the heavy queries
    if (specTotal === 0) continue;

    const cov = coverageStmt.get(p.id) as {
      spec_total: number;
      with_any_candidate: number;
      operator_confirmed: number;
    };

    const withCand = Number(cov.with_any_candidate ?? 0);
    const confirmed = Number(cov.operator_confirmed ?? 0);

    // Visibility filter (brief §3.3): show a project when it is flagged
    // show_on_dashboard=1 AND has at least one spec row (already guaranteed
    // by the specTotal===0 skip above). With ?includeHidden=1 we keep hidden
    // projects too (so the owner can un-hide them) — they still must have a
    // spec. No hard-coded id list: the only gate is the owner-set flag.
    const isVisible = Number(p.show_on_dashboard ?? 1) === 1;
    if (!includeHidden && !isVisible) continue;

    const top1Rows = top1Stmt.all(p.id) as Array<{ match_type: string; cnt: number }>;
    const top1Counts: Record<string, number> = {};
    for (const r of top1Rows) top1Counts[r.match_type] = Number(r.cnt);

    out.push({
      project_id: p.id,
      project_name: p.name,
      spec_total: specTotal,
      with_any_candidate: withCand,
      without_candidate: specTotal - withCand,
      memory_top1: top1Counts['learned_rule'] ?? 0,
      llm_top1: top1Counts['llm_suggestion'] ?? 0,
      name_sim_top1: top1Counts['name_similarity'] ?? 0,
      manual_top1: top1Counts['manual'] ?? 0,
      exact_article_top1: top1Counts['exact_article'] ?? 0,
      name_characteristics_top1: top1Counts['name_characteristics'] ?? 0,
      operator_confirmed: confirmed,
      // tautology per brief §2.1: confirmed-only response hides rivals →
      // any naive accuracy@1 measurement collapses to 100%. Frontend shows
      // a "honest number coming later" placeholder. Will flip to 'honest' once
      // the matching endpoint can be queried with a flag that returns all
      // candidates regardless of confirmation status (separate ticket В1.2).
      accuracy_at_1_status: 'tautology',
      accuracy_at_1_value: null,
      show_on_dashboard: isVisible ? 1 : 0,
    });
  }

  return out;
}

router.get('/api/metrics/dashboard', (req: Request, res: Response) => {
  try {
    // ?includeHidden=1 (also accepts true) — return hidden projects too so the
    // owner can un-hide them. Default view shows only show_on_dashboard=1.
    const includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
    const key: 'default' | 'all' = includeHidden ? 'all' : 'default';

    const now = Date.now();
    const slot = cache[key];
    if (slot && now - slot.at < TTL_MS) {
      return res.json(slot.data);
    }

    const data = computeMetrics(includeHidden);
    cache[key] = { at: now, data };
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: 'Не удалось собрать главные показатели',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Invalidate every cached dashboard view. Called when a project's visibility
// is toggled (POST /api/projects/:id/dashboard-visibility) so the change shows
// up immediately instead of after the 60s TTL.
export function invalidateDashboardCache(): void {
  cache.default = null;
  cache.all = null;
}

// Back-compat alias kept for the existing integration test, which mutates the
// DB between requests and clears the cache by this name.
export const _invalidateDashboardCacheForTests = invalidateDashboardCache;

export default router;
