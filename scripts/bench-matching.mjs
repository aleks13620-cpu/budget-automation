#!/usr/bin/env node

/**
 * Matching performance benchmark.
 *
 * Runs runMatching() on a set of pre-loaded projects, measures elapsed time
 * and computes match-rate metrics. Output is written to
 * docs/benchmark-reports/matching-<timestamp>.json so before/after deltas can
 * be compared after optimization changes.
 *
 * Usage:
 *   node scripts/bench-matching.mjs                 # default projects
 *   node scripts/bench-matching.mjs 18 20 28        # specific project ids
 *   node scripts/bench-matching.mjs --label before  # tag the report
 *
 * Env:
 *   ENABLE_OPENROUTER_LLM_MATCHING=false   (default — LLM disabled for stable measure)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// LLM off by default — we want a deterministic measurement of the classical tiers.
if (process.env.ENABLE_OPENROUTER_LLM_MATCHING === undefined) {
  process.env.ENABLE_OPENROUTER_LLM_MATCHING = 'false';
}

// ---------------------------------------------------------------------------
// Paths & ts-node bootstrap
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const reportsDir = path.join(repoRoot, 'docs', 'benchmark-reports');

const backendPkg = path.join(repoRoot, 'backend', 'package.json');
const backendRequire = createRequire(backendPkg);
backendRequire('ts-node').register({
  transpileOnly: true,
  project: path.join(repoRoot, 'backend', 'tsconfig.json'),
});

const { runMatching } = backendRequire('./src/services/matcher');
const Database = backendRequire('better-sqlite3');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let label = 'unlabeled';
const projectIds = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--label' && args[i + 1]) {
    label = args[i + 1];
    i++;
    continue;
  }
  const id = parseInt(args[i], 10);
  if (!Number.isNaN(id)) projectIds.push(id);
}
if (projectIds.length === 0) projectIds.push(18, 20, 28);

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
const dbPath = path.join(repoRoot, 'database', 'budget_automation.db');
const db = new Database(dbPath, { readonly: true });

function projectStats(projectId) {
  const proj = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
  if (!proj) return null;
  const spec = db.prepare('SELECT COUNT(*) as cnt, SUM(CASE WHEN full_name IS NOT NULL AND full_name != name THEN 1 ELSE 0 END) as with_fullname FROM specification_items WHERE project_id = ?').get(projectId);
  const inv = db.prepare('SELECT COUNT(ii.id) as cnt FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id WHERE i.project_id = ?').get(projectId);
  return { id: proj.id, name: proj.name, spec_count: spec.cnt, spec_with_fullname: spec.with_fullname, invoice_count: inv.cnt };
}

// ---------------------------------------------------------------------------
// Best candidate selection (replicates routes/matching.ts logic)
// ---------------------------------------------------------------------------
function pickBest(candidates) {
  const bestBySpec = new Map();
  for (const c of candidates) {
    const cur = bestBySpec.get(c.specItemId);
    if (!cur) { bestBySpec.set(c.specItemId, c); continue; }
    const better =
      (c.dnScore ?? 0) > (cur.dnScore ?? 0) ||
      ((c.dnScore ?? 0) === (cur.dnScore ?? 0) && (c.quantityScore ?? 0) > (cur.quantityScore ?? 0)) ||
      ((c.dnScore ?? 0) === (cur.dnScore ?? 0) && (c.quantityScore ?? 0) === (cur.quantityScore ?? 0) && c.confidence > cur.confidence);
    if (better) bestBySpec.set(c.specItemId, c);
  }
  return [...bestBySpec.values()];
}

function summarise(projectId, stats, candidates, elapsedMs) {
  const best = pickBest(candidates);
  const conf60 = best.filter(c => c.confidence >= 0.6).length;
  const conf80 = best.filter(c => c.confidence >= 0.8).length;
  const byTier = {};
  for (const c of best) byTier[c.matchType] = (byTier[c.matchType] || 0) + 1;
  return {
    project_id: projectId,
    project_name: stats.name,
    spec_count: stats.spec_count,
    spec_with_fullname: stats.spec_with_fullname,
    invoice_count: stats.invoice_count,
    pair_count: stats.spec_count * stats.invoice_count,
    elapsed_ms: elapsedMs,
    pairs_per_sec: Math.round(stats.spec_count * stats.invoice_count / (elapsedMs / 1000)),
    candidates_total: candidates.length,
    best_per_spec: best.length,
    conf_60: conf60,
    conf_60_pct: Math.round(conf60 / stats.spec_count * 1000) / 10,
    conf_80: conf80,
    conf_80_pct: Math.round(conf80 / stats.spec_count * 1000) / 10,
    by_tier: byTier,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const results = [];
  for (const pid of projectIds) {
    const stats = projectStats(pid);
    if (!stats) {
      console.error(`Project ${pid} not found, skipping`);
      continue;
    }
    console.log(`\n--- project ${pid}: ${stats.name} ---`);
    console.log(`spec=${stats.spec_count} (full_name=${stats.spec_with_fullname}) invoice=${stats.invoice_count} pairs=${stats.spec_count * stats.invoice_count}`);
    const t0 = Date.now();
    const candidates = await runMatching(pid);
    const elapsedMs = Date.now() - t0;
    const summary = summarise(pid, stats, candidates, elapsedMs);
    results.push(summary);
    console.log(`elapsed=${(elapsedMs / 1000).toFixed(1)}s  best_per_spec=${summary.best_per_spec}/${summary.spec_count} (${summary.conf_60_pct}% conf>=0.6, ${summary.conf_80_pct}% conf>=0.8)`);
    console.log(`by_tier:`, summary.by_tier);
  }

  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(reportsDir, `matching-${label}-${timestamp}.json`);
  const report = {
    label,
    timestamp: new Date().toISOString(),
    llm_enabled: process.env.ENABLE_OPENROUTER_LLM_MATCHING !== 'false',
    git_head: tryGitHead(repoRoot),
    projects: results,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${path.relative(repoRoot, outPath)}`);

  db.close();
  process.exit(0);
}

function tryGitHead(repoRoot) {
  try {
    const headFile = path.join(repoRoot, '.git', 'HEAD');
    const headRef = fs.readFileSync(headFile, 'utf8').trim();
    if (headRef.startsWith('ref:')) {
      const refPath = path.join(repoRoot, '.git', headRef.slice(5));
      return fs.readFileSync(refPath, 'utf8').trim().slice(0, 7);
    }
    return headRef.slice(0, 7);
  } catch { return null; }
}

main().catch(e => { console.error(e); process.exit(1); });
