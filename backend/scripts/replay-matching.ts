/**
 * Benchmark script: replay matching for a project, report before/after counts
 * and the top unmatched spec names.
 *
 * Run:
 *   cd backend
 *   npx tsx scripts/replay-matching.ts --project-id 4
 *   # or: npx ts-node --project tsconfig.scripts.json scripts/replay-matching.ts --project-id 4
 *
 * The script reads the local DB (path from DATABASE_PATH env / default in
 * connection.ts). It writes the new candidates into `matched_items` using the
 * same INSERT pattern as the production background job, so the after-count
 * reflects what an operator would see in the UI.
 *
 * Safety: this is intended for LOCAL DB only. Do NOT run against production.
 */

import path from 'path';
import dotenv from 'dotenv';

// Load .env before importing services so DATABASE_PATH / GEMINI keys are set.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { getDatabase } from '../src/database';
import { runMatching } from '../src/services/matcher';
import type { MatchCandidate } from '../src/services/matcher';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseProjectId(argv: string[]): number {
  const idx = argv.indexOf('--project-id');
  if (idx >= 0 && idx + 1 < argv.length) {
    const val = Number(argv[idx + 1]);
    if (Number.isFinite(val) && val > 0) return val;
  }
  // Support --project-id=4 syntax too.
  for (const arg of argv) {
    const m = arg.match(/^--project-id=(\d+)$/);
    if (m) return Number(m[1]);
  }
  return 4;
}

// ---------------------------------------------------------------------------
// Counting helpers
// ---------------------------------------------------------------------------

function countMatched(db: ReturnType<typeof getDatabase>, projectId: number): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT mi.specification_item_id) as cnt
    FROM matched_items mi
    JOIN specification_items si ON mi.specification_item_id = si.id
    WHERE si.project_id = ?
      AND mi.confidence >= 0.3
  `).get(projectId) as { cnt: number };
  return row.cnt;
}

function countSpecTotal(db: ReturnType<typeof getDatabase>, projectId: number): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM specification_items WHERE project_id = ?'
  ).get(projectId) as { cnt: number };
  return row.cnt;
}

function getUnmatchedSpecNames(
  db: ReturnType<typeof getDatabase>,
  projectId: number,
  limit: number,
): Array<{ id: number; name: string; section: string | null }> {
  return db.prepare(`
    SELECT si.id, si.name, si.section
    FROM specification_items si
    WHERE si.project_id = ?
      AND si.id NOT IN (
        SELECT mi.specification_item_id
        FROM matched_items mi
        WHERE mi.confidence >= 0.3
      )
    ORDER BY si.id
    LIMIT ?
  `).all(projectId, limit) as Array<{ id: number; name: string; section: string | null }>;
}

// ---------------------------------------------------------------------------
// Persistence — mirror runMatchingBackground's full-mode write path so the
// counts reflect what the UI would see.
// ---------------------------------------------------------------------------

function pickBestCandidatePerSpec(candidates: MatchCandidate[]): Map<number, MatchCandidate> {
  const best = new Map<number, MatchCandidate>();
  for (const candidate of candidates) {
    const current = best.get(candidate.specItemId);
    if (!current) {
      best.set(candidate.specItemId, candidate);
      continue;
    }
    const shouldReplace =
      (candidate.dnScore ?? 0) > (current.dnScore ?? 0)
      || ((candidate.dnScore ?? 0) === (current.dnScore ?? 0) && (candidate.quantityScore ?? 0) > (current.quantityScore ?? 0))
      || (
        (candidate.dnScore ?? 0) === (current.dnScore ?? 0)
        && (candidate.quantityScore ?? 0) === (current.quantityScore ?? 0)
        && candidate.confidence > current.confidence
      );
    if (shouldReplace) best.set(candidate.specItemId, candidate);
  }
  return best;
}

function persistCandidates(
  db: ReturnType<typeof getDatabase>,
  projectId: number,
  candidates: MatchCandidate[],
): void {
  const best = pickBestCandidatePerSpec(candidates);

  const insert = db.prepare(`
    INSERT INTO matched_items (
      specification_item_id, invoice_item_id, price_list_item_id, confidence,
      match_type, is_confirmed, is_selected, source, matching_rule_id, match_reason, is_analog
    )
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `);

  const runTx = db.transaction(() => {
    // Wipe unconfirmed matches for this project (full-mode behavior).
    db.prepare(`
      DELETE FROM matched_items
      WHERE is_confirmed = 0
        AND specification_item_id IN (
          SELECT id FROM specification_items WHERE project_id = ?
        )
    `).run(projectId);

    const confirmedSpecIds = new Set((db.prepare(`
      SELECT DISTINCT specification_item_id
      FROM matched_items
      WHERE is_confirmed = 1
        AND specification_item_id IN (SELECT id FROM specification_items WHERE project_id = ?)
    `).all(projectId) as { specification_item_id: number }[]).map(row => row.specification_item_id));

    for (const c of candidates) {
      if (confirmedSpecIds.has(c.specItemId)) continue;
      const source = c.source ?? 'invoice';
      const bestCandidate = best.get(c.specItemId);
      const isSelected =
        bestCandidate?.invoiceItemId === c.invoiceItemId
        && (bestCandidate.source ?? 'invoice') === source
          ? 1
          : 0;
      insert.run(
        c.specItemId,
        source === 'price_list' ? null : c.invoiceItemId,
        source === 'price_list' ? c.invoiceItemId : null,
        c.confidence,
        c.matchType,
        isSelected,
        source,
        c.matchingRuleId ?? null,
        c.matchReason ?? null,
        c.isAnalog ? 1 : 0,
      );
    }
  });
  runTx();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const projectId = parseProjectId(process.argv);
  console.log(`[replay-matching] project_id = ${projectId}`);

  const db = getDatabase();

  // Sanity: project must exist.
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as
    | { id: number; name: string }
    | undefined;
  if (!project) {
    console.error(`[replay-matching] project ${projectId} not found in local DB`);
    process.exit(1);
  }
  console.log(`[replay-matching] project name: ${project.name}`);

  const totalSpecs = countSpecTotal(db, projectId);
  const before = countMatched(db, projectId);
  console.log(`[replay-matching] before: ${before} / ${totalSpecs} specs matched (>=0.3)`);

  console.log(`[replay-matching] running matcher... (may take 2-5 min on large projects)`);
  const t0 = Date.now();
  const candidates = await runMatching(projectId);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[replay-matching] runMatching produced ${candidates.length} candidate rows in ${elapsed}s`);

  persistCandidates(db, projectId, candidates);

  const after = countMatched(db, projectId);
  const delta = after - before;
  const matchRate = totalSpecs > 0 ? (after / totalSpecs) * 100 : 0;

  console.log('');
  console.log('================ RESULTS ================');
  console.log(`before       : ${before}`);
  console.log(`after        : ${after}`);
  console.log(`delta        : ${delta >= 0 ? '+' : ''}${delta}`);
  console.log(`total_specs  : ${totalSpecs}`);
  console.log(`match_rate   : ${matchRate.toFixed(1)}%`);
  console.log('=========================================');
  console.log('');

  const unmatched = getUnmatchedSpecNames(db, projectId, 10);
  console.log(`Top ${unmatched.length} unmatched spec items:`);
  for (const row of unmatched) {
    const section = row.section ? ` [${row.section}]` : '';
    console.log(`  #${row.id}${section}  ${row.name}`);
  }

  if (unmatched.length === 0) {
    console.log('  (none — every spec has a candidate at conf>=0.3)');
  }
}

main().catch(err => {
  console.error('[replay-matching] fatal:', err);
  process.exit(1);
});
