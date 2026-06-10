#!/usr/bin/env node
/**
 * OFFLINE INTEGRATION TEST for POST /api/specifications/:id/resplit-clean.
 *
 * Drives the REAL endpoint core `resplitCleanSpec` (imported from
 * backend/src/routes/specifications.ts — NOT a re-implementation of the transform)
 * against a FRESH TEMP DB seeded from the read-only prod cache of project 11
 * (Ласточка ОВ). NEVER touches prod, NEVER re-uploads.
 *
 * The temp DB mirrors the prod FK shape and turns `PRAGMA foreign_keys = ON`, so the
 * `matched_items … ON DELETE CASCADE` and `operator_feedback.spec_item_id … ON DELETE
 * SET NULL` constraints are ARMED. If the endpoint ever deleted/reinserted a spec row
 * (as /reparse or a re-upload would), the cascade would fire and the assertions below
 * would catch it. The endpoint only UPDATEs BY id, so it never fires — that is the
 * whole proof.
 *
 * Metric 1 (this script): link preservation + idempotency + correctness + rollbackable
 *   snapshot. Metric 2 (matching lift 4.7%→55.3%) is measured by the sibling harness
 *   budget-automation-spec-repr/scripts/replay-spec-clean-repr.mjs (same transform).
 *
 * Usage: node backend/scripts/resplit-clean-endpoint.integration.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');
// Read-only prod snapshot lives with the offline harnesses (absolute, like its siblings).
const CACHE_DIR = 'C:/Users/home/vscode101/budget-automation-spec-repr/scripts';
const PROD_DB = 'C:/Users/home/vscode101/budget-automation/database/budget_automation.db';
const SPEC_ID = 5;       // synthetic specification id the seeded proj-11 rows belong to
const PROJECT_ID = 11;

// --- fresh temp DB (never prod) ---
const TMP_DB = path.join(os.tmpdir(), 'resplit_clean_endpoint_integration.db');
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /**/ } }
// Isolate any stray getDatabase()/LLM init triggered at import time onto throwaway paths.
process.env.DATABASE_PATH = path.join(os.tmpdir(), 'resplit_clean_endpoint_throwaway.db');
process.env.ENABLE_OPENROUTER_LLM_MATCHING = 'false';
process.env.OPENROUTER_API_KEY = '';

const backendRequire = createRequire(path.join(backendDir, 'package.json'));
backendRequire('ts-node').register({ transpileOnly: true, project: path.join(backendDir, 'tsconfig.json') });
const Database = backendRequire('better-sqlite3');
// THE CODE UNDER TEST — the actual endpoint core, not a copy of the transform.
const { resplitCleanSpec } = backendRequire('./src/routes/specifications');

// Hard guard: never let the temp path collapse onto prod.
if (path.resolve(TMP_DB) === path.resolve(PROD_DB)) { console.error('REFUSING to write prod DB'); process.exit(1); }

const cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, '.cache-verity-prod11.json'), 'utf8'));
const specObjs = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, '.cache-verity-prod11-specobjs.json'), 'utf8'));
const confirmedPairs = cache.confirmedPairs;

// --- build a prod-shaped temp DB with the cascade ARMED ---
const db = new Database(TMP_DB);
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE specification_items (
    id INTEGER PRIMARY KEY, project_id INTEGER, specification_id INTEGER, position_number TEXT,
    name TEXT, characteristics TEXT, equipment_code TEXT, article TEXT, product_code TEXT,
    marking TEXT, type_size TEXT, manufacturer TEXT, unit TEXT, quantity REAL,
    section TEXT, parent_item_id INTEGER, full_name TEXT);
  CREATE TABLE invoice_items (id INTEGER PRIMARY KEY, invoice_id INTEGER, name TEXT);
  -- matched_items: real prod FK + CASCADE. A re-upload/reparse trips this; UPDATE-by-id never does.
  CREATE TABLE matched_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, specification_item_id INTEGER NOT NULL, invoice_item_id INTEGER,
    is_confirmed INTEGER DEFAULT 0, source TEXT DEFAULT 'invoice',
    FOREIGN KEY (specification_item_id) REFERENCES specification_items(id) ON DELETE CASCADE);
  -- operator_feedback: the complaints themselves. SET NULL on delete = a re-upload would unlink them.
  CREATE TABLE operator_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_item_id INTEGER REFERENCES specification_items(id) ON DELETE SET NULL, note TEXT);
  CREATE TABLE specification_items_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, specification_id INTEGER, version INTEGER,
    items_snapshot TEXT, action TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`);

// Seed spec rows with their REAL prod ids, all under SPEC_ID.
const insSpec = db.prepare(`INSERT INTO specification_items
  (id, project_id, specification_id, name, characteristics, full_name, unit, quantity, position_number, parent_item_id, section)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
db.transaction(() => {
  for (const s of specObjs) {
    insSpec.run(s.id, PROJECT_ID, SPEC_ID, s.name ?? null, s.characteristics ?? null, s.full_name ?? null,
      s.unit ?? null, s.quantity ?? null, s.position_number ?? null, s.parent_item_id ?? null, s.section ?? null);
  }
})();
const seededIds = new Set(specObjs.map(s => s.id));

// Seed confirmed matches (mark ~25% source='manual' to model the hand-made links).
const seenInv = new Set();
const insInv = db.prepare('INSERT OR IGNORE INTO invoice_items (id, invoice_id, name) VALUES (?,1,?)');
const insMatch = db.prepare('INSERT INTO matched_items (specification_item_id, invoice_item_id, is_confirmed, source) VALUES (?,?,1,?)');
let manualSeeded = 0;
db.transaction(() => {
  for (let i = 0; i < confirmedPairs.length; i++) {
    const p = confirmedPairs[i];
    if (!seededIds.has(p.specId)) continue;
    if (!seenInv.has(p.correctInvId)) { insInv.run(p.correctInvId, p.correctInvName); seenInv.add(p.correctInvId); }
    const source = i % 4 === 0 ? 'manual' : 'auto';
    if (source === 'manual') manualSeeded++;
    insMatch.run(p.specId, p.correctInvId, source);
  }
})();

// Seed operator_feedback for complaint rows (incl. 2953 = live complaint #433) to prove
// the SET NULL path is NOT triggered (the complaints stay linked to their spec rows).
const feedbackSpecIds = [2953, ...specObjs.slice(0, 5).map(s => s.id)]
  .filter((v, i, a) => seededIds.has(v) && a.indexOf(v) === i);
const insFb = db.prepare('INSERT INTO operator_feedback (spec_item_id, note) VALUES (?,?)');
db.transaction(() => { for (const id of feedbackSpecIds) insFb.run(id, `complaint for spec_item ${id}`); })();

// --- snapshots / counters ---
const idSet = () => new Set(db.prepare('SELECT id FROM specification_items WHERE specification_id=?').all(SPEC_ID).map(r => r.id));
const counts = () => ({
  spec: db.prepare('SELECT COUNT(*) c FROM specification_items WHERE specification_id=?').get(SPEC_ID).c,
  matched: db.prepare('SELECT COUNT(*) c FROM matched_items').get().c,
  confirmed: db.prepare('SELECT COUNT(*) c FROM matched_items WHERE is_confirmed=1').get().c,
  manual: db.prepare("SELECT COUNT(*) c FROM matched_items WHERE source='manual'").get().c,
  feedbackLinked: db.prepare('SELECT COUNT(*) c FROM operator_feedback WHERE spec_item_id IS NOT NULL').get().c,
  history: db.prepare('SELECT COUNT(*) c FROM specification_items_history').get().c,
  orphans: db.prepare('SELECT COUNT(*) c FROM matched_items m LEFT JOIN specification_items s ON s.id=m.specification_item_id WHERE s.id IS NULL').get().c,
});

console.log(`temp DB: ${TMP_DB}`);
console.log(`seeded: ${specObjs.length} spec rows, ${counts().matched} confirmed matches (${manualSeeded} manual), ${feedbackSpecIds.length} feedback links\n`);

const before = counts();
const idsBefore = idSet();
console.log('BEFORE:', JSON.stringify(before));

// ===== CALL THE ENDPOINT CORE (pass 1) =====
const r1 = resplitCleanSpec(SPEC_ID, db);
const afterPass1 = counts();
const idsAfter = idSet();
console.log(`\nresplitCleanSpec pass 1: itemsTouched=${r1.itemsTouched} bareOrphanKept=${r1.bareOrphanKept} rowsScanned=${r1.rowsScanned}`);
console.log('AFTER  pass1:', JSON.stringify(afterPass1));
console.log('report.links:', JSON.stringify(r1.links));

// ===== idempotency (pass 2) =====
const r2 = resplitCleanSpec(SPEC_ID, db);
const afterPass2 = counts();
console.log(`resplitCleanSpec pass 2 (idempotency): itemsTouched=${r2.itemsTouched} (expect 0); history ${afterPass1.history}->${afterPass2.history} (expect no growth)`);

// ===== correctness on the #433 row 2953 =====
const sample = db.prepare('SELECT name, full_name, characteristics FROM specification_items WHERE id=2953').get();
const MARKER_RE = /исполнени|подключени|d\s*п\s*=|Q\s*=\s*[\d.,]+\s*(?:Вт|W|$)/i;
const sampleFullClean = sample && !MARKER_RE.test(sample.full_name || '');
const sampleCharsGained = sample && /исполнени/i.test(sample.characteristics || '') && /d\s*п\s*=/i.test(sample.characteristics || '');

// ===== rollbackable snapshot: the pass-1 snapshot holds the ORIGINAL (dirty) text =====
const snapRow = db.prepare("SELECT items_snapshot, action FROM specification_items_history WHERE specification_id=? ORDER BY version DESC LIMIT 1").get(SPEC_ID);
let snapshotHasOriginal = false, snapshotAction = null;
if (snapRow) {
  snapshotAction = snapRow.action;
  const snap = JSON.parse(snapRow.items_snapshot);
  const s2953 = snap.find(x => x.id === 2953);
  snapshotHasOriginal = !!(s2953 && /Левое исполнение/i.test(s2953.full_name || ''));
}

// ===== aggregate: only bare-orphans may still carry a marker in full_name (the key) =====
const keyStillDirty = db.prepare('SELECT id, full_name FROM specification_items WHERE specification_id=?')
  .all(SPEC_ID).filter(r => MARKER_RE.test(r.full_name || ''));

const idsStable = idsBefore.size === idsAfter.size && [...idsBefore].every(id => idsAfter.has(id));
const linksReport = r1.links;
const checks = [
  ['spec id set stable (no delete+reinsert)', idsStable],
  ['matched_items count unchanged', before.matched === afterPass1.matched],
  ['confirmed count unchanged', before.confirmed === afterPass1.confirmed],
  ['manual links count unchanged', before.manual === afterPass1.manual],
  ['feedback links unchanged (SET NULL not triggered)', before.feedbackLinked === afterPass1.feedbackLinked && afterPass1.feedbackLinked === feedbackSpecIds.length],
  ['0 orphaned matched_items after re-split', afterPass1.orphans === 0],
  ['report links before==after (matched)', linksReport.matchedBefore === linksReport.matchedAfter],
  ['report links before==after (confirmed)', linksReport.confirmedBefore === linksReport.confirmedAfter],
  ['report links before==after (feedback)', linksReport.feedbackBefore === linksReport.feedbackAfter],
  ['report orphansAfter == 0', linksReport.orphansAfter === 0],
  ['re-split changed rows (itemsTouched=128, matches recon)', r1.itemsTouched === 128],
  ['bareOrphanKept=72 (matches recon)', r1.bareOrphanKept === 72],
  ['idempotent: pass 2 itemsTouched=0', r2.itemsTouched === 0],
  ['idempotent: pass 2 wrote no snapshot', afterPass1.history === afterPass2.history],
  ['pass 1 wrote exactly one snapshot', before.history === 0 && afterPass1.history === 1],
  ['#433 row 2953: full_name cleaned (markers gone from key)', sampleFullClean],
  ['#433 row 2953: markers moved into characteristics', sampleCharsGained],
  ['snapshot action = resplit_clean_repr', snapshotAction === 'resplit_clean_repr'],
  ['snapshot holds ORIGINAL dirty text (rollbackable)', snapshotHasOriginal],
  ['only bare-orphan keys may still carry a marker', keyStillDirty.length <= r1.bareOrphanKept],
];

console.log('\nsample #433 row id=2953 AFTER re-split:');
console.log('  name         :', JSON.stringify(sample?.name));
console.log('  full_name    :', JSON.stringify(sample?.full_name));
console.log('  characteristics:', JSON.stringify(sample?.characteristics));

console.log('\n===== METRIC 1 — LINK PRESERVATION + IDEMPOTENCY + CORRECTNESS =====');
let allOk = true;
for (const [label, ok] of checks) { console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`); if (!ok) allOk = false; }

db.close();
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /**/ } }
console.log(`\n${allOk ? `ALL ${checks.length} CHECKS PASSED — endpoint is CASCADE-safe, idempotent, rollbackable.` : 'CHECKS FAILED'}`);
process.exit(allOk ? 0 : 1);
