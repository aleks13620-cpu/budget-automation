/**
 * Integration test for GET /api/metrics/dashboard.
 *
 * Strategy: build an isolated SQLite DB with a known set of spec_items and
 * matched_items, point getDatabase() at it, then directly drive the route
 * handler via a fake express req/res. Verifies the contract from
 * worker_brief_2026-06-14_metrics_dashboard_v1.md §2.1 + fixes §2.2-2.3:
 *   - returns one object per live project (spec_total > 100 AND has signal)
 *   - the 10 numeric fields are computed correctly
 *   - accuracy_at_1_status === 'tautology' and value === null (V1 contract)
 *   - empty / tiny / stale-big projects are filtered out
 *   - top-1 is is_selected=1 (fallback by confidence DESC, id ASC), matching
 *     the tier breakdown query in /matching (matching.ts:741-747)
 *   - is_selected=1 takes priority even when a rival has higher confidence
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
import metricsDashboardRoutes, { _invalidateDashboardCacheForTests } from './src/routes/metricsDashboard';

function setupSchema(db: Database.Database) {
  // Minimal schema mirroring the columns metricsDashboard reads. We do NOT
  // import the real init.ts because that runs migrations and seeders that the
  // test doesn't need.
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
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
  // Project 100: "live" via spec_total > 100 (107 items).
  // - 60 with a learned_rule top-1 (memory_top1 = 60), is_selected=1
  // - 20 with a llm_suggestion top-1 (llm_top1 = 20), is_selected=1
  // - 10 with a name_similarity top-1, is_selected=1
  // - 2 with NO matches (without_candidate = 2)
  // - 10 with two rivals: learned_rule (low conf, is_selected=1) vs
  //   exact_article (higher conf, is_selected=0). With the new is_selected-first
  //   tie-break, learned_rule wins (memory_top1). These 10 are confirmed too.
  // - 5 NEW: manual match (is_selected=1, confirmed=1) → manual_top1 = 5
  // Expected:
  //   spec_total = 107, with_any_candidate = 105, without_candidate = 2,
  //   memory_top1 = 70 (60 + 10 with rival), llm_top1 = 20, name_sim_top1 = 10,
  //   manual_top1 = 5, exact_article_top1 = 0, name_characteristics_top1 = 0,
  //   operator_confirmed = 15 (10 rival rows + 5 manual)
  db.exec("INSERT INTO projects (id, name) VALUES (100, 'Live Project A')");
  const insSpec = db.prepare('INSERT INTO specification_items (id, project_id, name) VALUES (?, 100, ?)');
  const insMatch = db.prepare(
    'INSERT INTO matched_items (specification_item_id, match_type, confidence, is_confirmed, is_selected) VALUES (?, ?, ?, ?, ?)'
  );

  let specId = 1000;
  // 60 learned_rule
  for (let i = 0; i < 60; i++) {
    specId++;
    insSpec.run(specId, `Item LR ${i}`);
    insMatch.run(specId, 'learned_rule', 0.9, 0, 1);
  }
  // 20 llm
  for (let i = 0; i < 20; i++) {
    specId++;
    insSpec.run(specId, `Item LLM ${i}`);
    insMatch.run(specId, 'llm_suggestion', 0.85, 0, 1);
  }
  // 10 name_similarity
  for (let i = 0; i < 10; i++) {
    specId++;
    insSpec.run(specId, `Item NS ${i}`);
    insMatch.run(specId, 'name_similarity', 0.7, 0, 1);
  }
  // 10 with two rivals — learned_rule is_selected=1 wins top-1 even though
  // exact_article has higher confidence. Proves is_selected takes priority.
  // (Also confirmed=1 on the selected one.)
  for (let i = 0; i < 10; i++) {
    specId++;
    insSpec.run(specId, `Item LR+EA ${i}`);
    insMatch.run(specId, 'learned_rule', 0.6, 1, 1);
    insMatch.run(specId, 'exact_article', 0.95, 0, 0);
  }
  // 5 manual (new in fixes §2.3 — exercises manual_top1 field)
  for (let i = 0; i < 5; i++) {
    specId++;
    insSpec.run(specId, `Item MAN ${i}`);
    insMatch.run(specId, 'manual', 1.0, 1, 1);
  }
  // 2 with no matches at all
  for (let i = 0; i < 2; i++) {
    specId++;
    insSpec.run(specId, `Item NONE ${i}`);
  }
}

function seedScenarioB(db: Database.Database) {
  // Project 200: tiny (5 items, 0 confirmed) — must be FILTERED OUT.
  db.exec("INSERT INTO projects (id, name) VALUES (200, 'Tiny Sandbox')");
  const insSpec = db.prepare('INSERT INTO specification_items (id, project_id, name) VALUES (?, 200, ?)');
  for (let i = 0; i < 5; i++) {
    insSpec.run(2000 + i, `Tiny ${i}`);
  }
}

function seedScenarioC(db: Database.Database) {
  // Project 300: live — bigEnough (110 spec items > 100) AND has signal
  // (60 operator_confirmed > 50). Mirrors a mature project like Сокольи ВК.
  db.exec("INSERT INTO projects (id, name) VALUES (300, 'Live Project C')");
  const insSpec = db.prepare('INSERT INTO specification_items (id, project_id, name) VALUES (?, 300, ?)');
  const insMatch = db.prepare(
    'INSERT INTO matched_items (specification_item_id, match_type, confidence, is_confirmed, is_selected) VALUES (?, ?, ?, ?, ?)'
  );
  // 110 spec items, 60 of them confirmed → live via both gates.
  for (let i = 0; i < 110; i++) {
    const sid = 3000 + i;
    insSpec.run(sid, `C ${i}`);
    if (i < 60) {
      insMatch.run(sid, 'learned_rule', 0.9, 1, 1);
    } else {
      // The rest have no matches at all — they push spec_total above 100 but
      // don't change memory_top1; confirmed remains 60.
    }
  }
}

function seedScenarioD(db: Database.Database) {
  // Project 400: BIG (200 items) but NO matches anywhere → mimics a stale
  // E2E sandbox uploaded but never matched. Must be FILTERED OUT under the
  // new hasSignal gate (with_any_candidate=0 AND confirmed=0).
  db.exec("INSERT INTO projects (id, name) VALUES (400, 'Big Stale Sandbox')");
  const insSpec = db.prepare('INSERT INTO specification_items (id, project_id, name) VALUES (?, 400, ?)');
  for (let i = 0; i < 200; i++) {
    insSpec.run(4000 + i, `Stale ${i}`);
  }
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
}

async function callDashboard(): Promise<MetricRow[]> {
  // Spin up a real express app on an ephemeral port, hit it with http.get.
  // Cheaper than supertest, doesn't add a dep.
  const app = express();
  app.use(metricsDashboardRoutes);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('no address'));
        return;
      }
      http
        .get(`http://127.0.0.1:${addr.port}/api/metrics/dashboard`, (res) => {
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
  seedScenarioB(db);
  seedScenarioC(db);
  seedScenarioD(db);

  _invalidateDashboardCacheForTests();
  const rows = await callDashboard();

  console.log('Response:', JSON.stringify(rows, null, 2));
  console.log();

  // Scenarios B (tiny) and D (big but stale, no matches) must be filtered out.
  console.log('Filtering:');
  assertEq('total rows', rows.length, 2);
  const ids = rows.map((r) => r.project_id).sort((a, b) => a - b);
  assertEq('project ids', JSON.stringify(ids), JSON.stringify([100, 300]));

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
  // 10 rival rows have confirmed=1 on the selected LR + 5 manual rows confirmed
  assertEq('operator_confirmed', a.operator_confirmed, 15);
  assertEq('accuracy_at_1_status', a.accuracy_at_1_status, 'tautology');
  assertEq('accuracy_at_1_value', a.accuracy_at_1_value, null);

  console.log('\nProject 300 (Live C — 110 items, 60 confirmed):');
  const c = rows.find((r) => r.project_id === 300)!;
  assertEq('spec_total', c.spec_total, 110);
  assertEq('with_any_candidate', c.with_any_candidate, 60);
  assertEq('without_candidate', c.without_candidate, 50);
  assertEq('memory_top1', c.memory_top1, 60);
  assertEq('operator_confirmed', c.operator_confirmed, 60);

  // Caching sanity: second call should be instant — just verify it returns
  // the same shape.
  console.log('\nCache hit:');
  const rows2 = await callDashboard();
  assertEq('cached rows count', rows2.length, 2);

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
