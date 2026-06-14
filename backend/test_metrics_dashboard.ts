/**
 * Integration test for GET /api/metrics/dashboard + the show_on_dashboard
 * visibility flag (worker_brief_2026-06-14_dashboard_visibility_flag).
 *
 * Strategy: build an isolated SQLite DB with a known set of projects /
 * spec_items / matched_items, point getDatabase() at it, then drive the route
 * handler via a real (ephemeral-port) express app. Verifies:
 *   - the 11 fields (10 numeric + project_name + show_on_dashboard) per project
 *   - top-1 is is_selected=1 (fallback by confidence DESC, id ASC), matching
 *     the tier breakdown query in /matching (matching.ts:741-747)
 *   - is_selected=1 takes priority even when a rival has higher confidence
 *   - NEW filter (brief §3.3): show only show_on_dashboard=1 AND spec_total>0.
 *     An empty project (spec_total=0) is always dropped; a project with
 *     show_on_dashboard=0 is dropped from the default view.
 *   - NEW ?includeHidden=1: hidden projects (with a spec) come back too, each
 *     carrying show_on_dashboard so the UI can label / un-hide them.
 *   - NEW toggle effect: flipping show_on_dashboard + invalidating the cache
 *     (the contract of POST /api/projects/:id/dashboard-visibility) moves a
 *     project between the default and includeHidden views.
 *
 * Run: ts-node test_metrics_dashboard.ts (no jest/mocha; same shape as the
 * other test_*.ts scripts in this folder).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import express from 'express';
import http from 'http';

// Stand up an isolated DB before requiring the route (so getDatabase picks
// it up via DATABASE_PATH — see backend/src/database/connection.ts).
const tmpDbPath = path.join(os.tmpdir(), `metrics-dashboard-test-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDbPath;

import { getDatabase } from './src/database';
import metricsDashboardRoutes, { invalidateDashboardCache } from './src/routes/metricsDashboard';

function setupSchema(db: Database.Database) {
  // Minimal schema mirroring the columns metricsDashboard reads. We do NOT
  // import the real init.ts because that runs migrations and seeders that the
  // test doesn't need. The projects table includes show_on_dashboard with the
  // same NOT NULL DEFAULT 1 the migration adds, so we test the live shape.
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      show_on_dashboard INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE specification_items (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE matched_items (
      id INTEGER PRIMARY KEY,
      specification_item_id INTEGER NOT NULL,
      invoice_item_id INTEGER,
      price_list_item_id INTEGER,
      match_type TEXT NOT NULL,
      confidence REAL NOT NULL,
      is_confirmed INTEGER DEFAULT 0,
      is_selected INTEGER DEFAULT 0
    );
  `);
}

function seedScenarioA(db: Database.Database) {
  // Project 100: visible (show_on_dashboard defaults to 1), 107 spec items.
  // - 60 with a learned_rule top-1 (is_selected=1)
  // - 20 with a llm_suggestion top-1 (is_selected=1)
  // - 10 with a name_similarity top-1 (is_selected=1)
  // - 10 with two rivals: learned_rule (low conf, is_selected=1) vs
  //   exact_article (higher conf, is_selected=0). is_selected wins → memory.
  //   These 10 are confirmed too.
  // - 5 manual (is_selected=1, confirmed=1)
  // - 2 with NO matches (without_candidate = 2)
  // Expected: spec_total=107, with_any_candidate=105, without_candidate=2,
  //   memory_top1=70, llm_top1=20, name_sim_top1=10, manual_top1=5,
  //   exact_article_top1=0, name_characteristics_top1=0, operator_confirmed=15,
  //   show_on_dashboard=1.
  db.exec("INSERT INTO projects (id, name) VALUES (100, 'Live Project A')");
  const insSpec = db.prepare('INSERT INTO specification_items (id, project_id, name) VALUES (?, 100, ?)');
  const insMatch = db.prepare(
    'INSERT INTO matched_items (specification_item_id, match_type, confidence, is_confirmed, is_selected) VALUES (?, ?, ?, ?, ?)'
  );

  let specId = 1000;
  for (let i = 0; i < 60; i++) { specId++; insSpec.run(specId, `Item LR ${i}`); insMatch.run(specId, 'learned_rule', 0.9, 0, 1); }
  for (let i = 0; i < 20; i++) { specId++; insSpec.run(specId, `Item LLM ${i}`); insMatch.run(specId, 'llm_suggestion', 0.85, 0, 1); }
  for (let i = 0; i < 10; i++) { specId++; insSpec.run(specId, `Item NS ${i}`); insMatch.run(specId, 'name_similarity', 0.7, 0, 1); }
  // 10 rivals — learned_rule is_selected=1 wins top-1 even though exact_article
  // has higher confidence. Proves is_selected takes priority. (confirmed=1 too.)
  for (let i = 0; i < 10; i++) {
    specId++;
    insSpec.run(specId, `Item LR+EA ${i}`);
    insMatch.run(specId, 'learned_rule', 0.6, 1, 1);
    insMatch.run(specId, 'exact_article', 0.95, 0, 0);
  }
  for (let i = 0; i < 5; i++) { specId++; insSpec.run(specId, `Item MAN ${i}`); insMatch.run(specId, 'manual', 1.0, 1, 1); }
  for (let i = 0; i < 2; i++) { specId++; insSpec.run(specId, `Item NONE ${i}`); }
}

function seedScenarioHidden(db: Database.Database) {
  // Project 200: a real project the OWNER hid (show_on_dashboard=0). It has a
  // spec, so it is NOT empty — under the new filter it is hidden from the
  // default view but returned by ?includeHidden=1, carrying show_on_dashboard=0.
  db.exec("INSERT INTO projects (id, name, show_on_dashboard) VALUES (200, 'Hidden Test Project', 0)");
  const insSpec = db.prepare('INSERT INTO specification_items (id, project_id, name) VALUES (?, 200, ?)');
  const insMatch = db.prepare(
    'INSERT INTO matched_items (specification_item_id, match_type, confidence, is_confirmed, is_selected) VALUES (?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < 30; i++) {
    const sid = 2000 + i;
    insSpec.run(sid, `H ${i}`);
    insMatch.run(sid, 'learned_rule', 0.9, 0, 1);
  }
}

function seedScenarioEmpty(db: Database.Database) {
  // Project 300: visible flag default=1 but ZERO spec items → must be dropped
  // from BOTH views (the spec_total>0 half of the filter, brief §3.3).
  db.exec("INSERT INTO projects (id, name) VALUES (300, 'Empty Project')");
}

interface MetricRow {
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
  accuracy_at_1_status: string;
  accuracy_at_1_value: number | null;
  show_on_dashboard: number;
}

async function callDashboard(includeHidden = false): Promise<MetricRow[]> {
  // Spin up a real express app on an ephemeral port, hit it with http.get.
  // Cheaper than supertest, doesn't add a dep.
  const app = express();
  app.use(metricsDashboardRoutes);
  const qs = includeHidden ? '?includeHidden=1' : '';
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('no address'));
        return;
      }
      http
        .get(`http://127.0.0.1:${addr.port}/api/metrics/dashboard${qs}`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c.toString()));
          res.on('end', () => {
            server.close();
            if (res.statusCode !== 200) {
              reject(new Error(`status ${res.statusCode}: ${body}`));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', (e) => {
          server.close();
          reject(e);
        });
    });
  });
}

function assertEq<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    console.error(`  FAIL: ${label}: expected ${expected}, got ${actual}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${label} = ${actual}`);
  }
}

async function main() {
  // fresh DB
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  const db = getDatabase();
  setupSchema(db);

  seedScenarioA(db);
  seedScenarioHidden(db);
  seedScenarioEmpty(db);

  invalidateDashboardCache();
  const rows = await callDashboard();

  console.log('Default view response:', JSON.stringify(rows, null, 2));
  console.log();

  // Default view: only project 100. 200 is hidden (show=0), 300 is empty.
  console.log('Filtering (default view = show_on_dashboard=1 AND spec_total>0):');
  assertEq('total rows', rows.length, 1);
  assertEq('only project 100', rows[0]?.project_id, 100);

  console.log('\nProject 100 (Live A):');
  const a = rows.find((r) => r.project_id === 100)!;
  assertEq('name', a.project_name, 'Live Project A');
  assertEq('spec_total', a.spec_total, 107);
  assertEq('with_any_candidate', a.with_any_candidate, 105);
  assertEq('without_candidate', a.without_candidate, 2);
  // memory_top1=70 proves is_selected-first wins: 60 plain LR + 10 rival LR
  // (selected) beats higher-confidence exact_article (not selected).
  assertEq('memory_top1', a.memory_top1, 70);
  assertEq('llm_top1', a.llm_top1, 20);
  assertEq('name_sim_top1', a.name_sim_top1, 10);
  assertEq('manual_top1', a.manual_top1, 5);
  assertEq('exact_article_top1', a.exact_article_top1, 0);
  assertEq('name_characteristics_top1', a.name_characteristics_top1, 0);
  assertEq('operator_confirmed', a.operator_confirmed, 15);
  assertEq('accuracy_at_1_status', a.accuracy_at_1_status, 'tautology');
  assertEq('accuracy_at_1_value', a.accuracy_at_1_value, null);
  assertEq('show_on_dashboard', a.show_on_dashboard, 1);

  // includeHidden view: project 100 AND the hidden 200 (with show=0). Still NOT
  // the empty project 300 (the spec_total>0 half of the filter always applies).
  console.log('\nincludeHidden view (= all projects with spec_total>0):');
  invalidateDashboardCache();
  const all = await callDashboard(true);
  const allIds = all.map((r) => r.project_id).sort((x, y) => x - y);
  assertEq('rows count', all.length, 2);
  assertEq('ids', JSON.stringify(allIds), JSON.stringify([100, 200]));
  const hidden = all.find((r) => r.project_id === 200)!;
  assertEq('hidden project show_on_dashboard', hidden.show_on_dashboard, 0);
  assertEq('hidden project spec_total', hidden.spec_total, 30);
  assertEq('empty project absent in includeHidden', all.some(r => r.project_id === 300), false);

  // Toggle effect (the contract of POST /api/projects/:id/dashboard-visibility):
  // hide project 100, invalidate cache, and confirm it leaves the default view
  // but is still reachable via includeHidden with show_on_dashboard=0.
  console.log('\nToggle: hide project 100 (UPDATE + invalidate cache):');
  db.prepare('UPDATE projects SET show_on_dashboard = 0 WHERE id = ?').run(100);
  invalidateDashboardCache();
  const afterHide = await callDashboard();
  assertEq('default view now empty', afterHide.length, 0);
  const afterHideAll = await callDashboard(true);
  const p100 = afterHideAll.find((r) => r.project_id === 100);
  assertEq('project 100 still in includeHidden', !!p100, true);
  assertEq('project 100 now show_on_dashboard=0', p100?.show_on_dashboard, 0);

  // Toggle back: show project 100 again → reappears in default view.
  console.log('\nToggle: show project 100 again:');
  db.prepare('UPDATE projects SET show_on_dashboard = 1 WHERE id = ?').run(100);
  invalidateDashboardCache();
  const afterShow = await callDashboard();
  assertEq('project 100 back in default view', afterShow.some(r => r.project_id === 100), true);

  // Caching sanity: a second call without invalidation returns the same shape.
  console.log('\nCache hit (no invalidation between calls):');
  const rows2 = await callDashboard();
  assertEq('cached rows count', rows2.length, afterShow.length);

  // cleanup
  db.close();
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);

  if (process.exitCode === 1) {
    console.error('\nSOME ASSERTIONS FAILED');
    process.exit(1);
  } else {
    console.log('\nALL ASSERTIONS PASSED');
  }
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});
