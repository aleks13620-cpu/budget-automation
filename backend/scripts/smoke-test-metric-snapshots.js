#!/usr/bin/env node
// Smoke test for Phase 1 learning-metrics capture (services/metricSnapshots).
// Verifies recordMetricSnapshot writes correct counts, snapshotAllProjects works,
// and the function NEVER throws (must be safe inside operator-action transactions).

const Database = require('better-sqlite3');
const path = require('path');
const tmpDb = path.join(__dirname, 'smoke-test-metrics-tmp.db');
try { require('fs').unlinkSync(tmpDb); } catch {}

const { CREATE_TABLES_SQL } = require(path.join(__dirname, '..', 'dist', 'database', 'schema'));
const { recordMetricSnapshot, snapshotAllProjects, getMetricsHistory } =
  require(path.join(__dirname, '..', 'dist', 'services', 'metricSnapshots'));

const db = new Database(tmpDb);
db.pragma('foreign_keys = ON');
db.exec(CREATE_TABLES_SQL);
// init.ts adds matching_rules.source via ALTER (not in CREATE_TABLES) — replicate it.
try { db.exec("ALTER TABLE matching_rules ADD COLUMN source TEXT DEFAULT 'manual'"); } catch {}

// Seed: 1 project, 3 spec items; spec 101 = selected LLM + confirmed,
// spec 102 = selected name_similarity (unconfirmed), spec 103 = unmatched.
db.prepare("INSERT INTO projects (id, name) VALUES (1, 'P1')").run();
db.prepare("INSERT INTO specification_items (id, project_id, name) VALUES (101,1,'a'),(102,1,'b'),(103,1,'c')").run();
db.prepare("INSERT INTO invoices (id, project_id) VALUES (9, 1)").run();
db.prepare("INSERT INTO invoice_items (id, invoice_id, name) VALUES (201,9,'ia'),(202,9,'ib')").run();
db.prepare(`INSERT INTO matched_items (specification_item_id, invoice_item_id, match_type, is_selected, is_confirmed, source)
            VALUES (101,201,'llm_suggestion',1,1,'invoice'),(102,202,'name_similarity',1,0,'invoice')`).run();
db.prepare("INSERT INTO construction_synonyms (abbreviation, full_form, category, source) VALUES ('x','full','cat','learned')").run();
db.prepare("INSERT INTO matching_rules (specification_pattern, invoice_pattern, source) VALUES ('p','q','learned'),('p2','q2','manual')").run();

let failures = 0;
const check = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

// 1) operator_action snapshot — correct counts
recordMetricSnapshot(db, 1, 'operator_action', 'confirm');
const row = db.prepare('SELECT * FROM metric_snapshots ORDER BY id DESC LIMIT 1').get();
check('row written', !!row);
check('total=3', row && row.total === 3);
check('matched=2', row && row.matched === 2);
check('confirmed=1', row && row.confirmed === 1);
check('kind=operator_action', row && row.kind === 'operator_action');
check('action_type=confirm', row && row.action_type === 'confirm');
check('learned_synonyms=1', row && row.learned_synonyms === 1);
check('learned_rules=2 (whole rule base, any source)', row && row.learned_rules === 2);
const tiers = row ? JSON.parse(row.tier_breakdown) : {};
check('tier llm_suggestion=1', tiers.llm_suggestion === 1);
check('tier name_similarity=1', tiers.name_similarity === 1);

// 2) snapshotAllProjects → one row per project
const before = db.prepare('SELECT COUNT(*) c FROM metric_snapshots').get().c;
snapshotAllProjects(db, 'startup');
const after = db.prepare('SELECT COUNT(*) c FROM metric_snapshots').get().c;
check('snapshotAllProjects added 1 row (1 project)', after - before === 1);

// 3a) empty project that EXISTS (no spec items) → zero-row snapshot, no throw
db.prepare("INSERT INTO projects (id, name) VALUES (2, 'Empty')").run();
let threw = false;
try { recordMetricSnapshot(db, 2, 'manual'); } catch { threw = true; }
check('no throw on empty project', !threw);
const zrow = db.prepare('SELECT * FROM metric_snapshots WHERE project_id=2 ORDER BY id DESC LIMIT 1').get();
check('empty-project row total=0/matched=0', !!zrow && zrow.total === 0 && zrow.matched === 0);
// 3b) non-existent project → FK protects integrity, snapshot safely skipped, no throw
let threw999 = false;
try { recordMetricSnapshot(db, 999, 'manual'); } catch { threw999 = true; }
check('no throw on non-existent project (FK skip)', !threw999);

// 4) never throws even on a broken db handle (must not break the user action)
let threw2 = false;
try { recordMetricSnapshot({ prepare() { throw new Error('boom'); } }, 1, 'manual'); } catch { threw2 = true; }
check('never throws on internal error', !threw2);

// 5) getMetricsHistory — NEWEST-N returned in chronological order (the Phase 2 read path)
db.prepare("INSERT INTO projects (id, name) VALUES (3, 'Hist')").run();
db.prepare("INSERT INTO specification_items (id, project_id, name) VALUES (301,3,'s')").run();
for (let i = 0; i < 5; i++) recordMetricSnapshot(db, 3, 'matching_run');
const allHist = getMetricsHistory(db, 3, 100);
check('history returns all 5 snapshots', allHist.length === 5);
check('history chronological (ascending id)', allHist.every((p, i) => i === 0 || p.id > allHist[i - 1].id));
check('history coverage is a number', typeof allHist[0].coverage === 'number');
const ids = allHist.map(p => p.id);
const maxId = Math.max(...ids), minId = Math.min(...ids);
const newest2 = getMetricsHistory(db, 3, 2);
check('limit=2 returns 2', newest2.length === 2);
check('limit returns the NEWEST (includes max id)', newest2.some(p => p.id === maxId));
check('limit drops the OLDEST (excludes min id)', !newest2.some(p => p.id === minId));
check('limited result still chronological', newest2[0].id < newest2[1].id);
check('history empty for project with no snapshots', getMetricsHistory(db, 999, 10).length === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
try { require('fs').unlinkSync(tmpDb); } catch {}
process.exit(failures === 0 ? 0 : 1);
