#!/usr/bin/env node
// Smoke test for Phase 2 (#18 filter)
// Verifies abbrevMatchesExpansion correctly blocks 6 noise patterns
// and allows 6 known-correct patterns.

const Database = require('better-sqlite3');
const path = require('path');
const tmpDb = path.join(__dirname, 'smoke-test-tmp.db');

// Clean previous run
try { require('fs').unlinkSync(tmpDb); } catch {}

const db = new Database(tmpDb);
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE construction_synonyms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    abbreviation TEXT NOT NULL,
    full_form TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'seed',
    times_used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX idx_construction_syn_unique
    ON construction_synonyms(abbreviation, full_form, category);
`);

// Build a tiny stub for invalidateMatcherSynonymCaches (avoid loading matcher)
require.cache[require.resolve(path.join(__dirname, '..', 'dist', 'services', 'matcher'))] = {
  exports: { invalidateMatcherSynonymCaches: () => {} }
};

const { learnConstructionSynonymsFromConfirmedMatch } =
  require(path.join(__dirname, '..', 'dist', 'services', 'constructionSynonymLearner'));

// 6 noise cases — should NOT be added
const noiseCases = [
  { spec: '10 шт труб', invoice: '150мм труб', expectKey: ['10', '150мм'] },
  { spec: 'муфта 32 ппр', invoice: '32x20x32 муфта', expectKey: ['32', '32x20x32'] },
  { spec: 'тройник 40', invoice: '40x32x40 тройник', expectKey: ['40', '40x32x40'] },
  { spec: 'переход 50', invoice: '50x32x50 переход', expectKey: ['50', '50x32x50'] },
  { spec: 'трубка 30', invoice: '32x20x32 трубка', expectKey: ['30', '32x20x32'] },
  { spec: '30вт элемент', invoice: '32x20x32вт элемент', expectKey: ['30вт', '32x20x32вт'] },
];

// 6 correct cases — SHOULD be added
const correctCases = [
  { spec: 'муфта vt 214', invoice: 'муфта valtec 214', expectKey: ['vt', 'valtec'] },
  { spec: 'кран ст 15', invoice: 'кран стальной 15', expectKey: ['ст', 'стальной'] },
  { spec: 'фитинг угол 90', invoice: 'фитинг угольник 90', expectKey: ['угол', 'угольник'] },
  { spec: 'переход конц 50', invoice: 'переход концентрический 50', expectKey: ['конц', 'концентрический'] },
  { spec: 'муфта чуг ду15', invoice: 'муфта чугунная ду15', expectKey: ['чуг', 'чугунная'] },
  { spec: 'тройник равн 32', invoice: 'тройник равнопроходной 32', expectKey: ['равн', 'равнопроходной'] },
];

function countSynonyms(abbr, full) {
  return db.prepare(
    "SELECT COUNT(*) c FROM construction_synonyms WHERE abbreviation = ? AND full_form = ?"
  ).get(abbr, full).c;
}

let failed = [];
console.log('=== NOISE cases (should NOT be added) ===');
for (const t of noiseCases) {
  const before = countSynonyms(t.expectKey[0], t.expectKey[1]);
  learnConstructionSynonymsFromConfirmedMatch(db, t.spec, t.invoice, 0.96);
  const after = countSynonyms(t.expectKey[0], t.expectKey[1]);
  const wasAdded = after > before;
  const status = wasAdded ? 'FAIL (added)' : 'OK (blocked)';
  console.log('  [' + status + '] ' + t.expectKey[0] + ' → ' + t.expectKey[1]);
  if (wasAdded) failed.push('NOISE NOT BLOCKED: ' + t.expectKey.join(' → '));
}

console.log('\n=== CORRECT cases (SHOULD be added) ===');
for (const t of correctCases) {
  const before = countSynonyms(t.expectKey[0], t.expectKey[1]);
  learnConstructionSynonymsFromConfirmedMatch(db, t.spec, t.invoice, 0.96);
  const after = countSynonyms(t.expectKey[0], t.expectKey[1]);
  const wasAdded = after > before;
  const status = wasAdded ? 'OK (added)' : 'FAIL (blocked)';
  console.log('  [' + status + '] ' + t.expectKey[0] + ' → ' + t.expectKey[1]);
  if (!wasAdded) failed.push('CORRECT NOT ADDED: ' + t.expectKey.join(' → '));
}

console.log('\n=== Summary ===');
const totalSyn = db.prepare("SELECT COUNT(*) c FROM construction_synonyms").get().c;
console.log('synonyms in DB after smoke:', totalSyn);
const all = db.prepare("SELECT abbreviation, full_form FROM construction_synonyms").all();
for (const r of all) console.log('  ' + r.abbreviation + ' → ' + r.full_form);

if (failed.length === 0) {
  console.log('\nSMOKE TEST: PASS — 0 noise added, 6 correct added');
  db.close();
  require('fs').unlinkSync(tmpDb);
  process.exit(0);
} else {
  console.log('\nSMOKE TEST: FAIL — ' + failed.length + ' issues:');
  for (const f of failed) console.log('  ' + f);
  db.close();
  require('fs').unlinkSync(tmpDb);
  process.exit(1);
}
