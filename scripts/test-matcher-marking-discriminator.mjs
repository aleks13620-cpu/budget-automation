#!/usr/bin/env node

/**
 * Red-first tests for the matcher marking / type-size discriminator.
 *
 * The matcher must DISTINGUISH marking / type-size variants so the wrong
 * variant does not become auto-#1, applying a hard mismatch penalty modelled
 * on the existing DN logic. This harness drives the public scoring helpers
 * (`getStructuralScore`, `extractDnValue`, `extractMarkingFeatures`) with
 * synthetic inputs — no DB, no network.
 *
 * Red-first: written BEFORE the discriminator logic. Before the fix the five
 * feature groups fail (the DN-only score returns 0); the DN guard group passes
 * both before and after to prove existing behaviour is preserved.
 *
 * Usage: node scripts/test-matcher-marking-discriminator.mjs
 *        npm run test:matcher          (from backend/)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// ts-node bootstrap (CommonJS module with TypeScript), DB-free import.
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backendPkg = path.join(repoRoot, 'backend', 'package.json');
const backendRequire = createRequire(backendPkg);
backendRequire('ts-node').register({
  transpileOnly: true,
  project: path.join(repoRoot, 'backend', 'tsconfig.json'),
});
const { getStructuralScore, extractDnValue, extractMarkingFeatures } =
  backendRequire('./src/services/matcher');

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`PASS ${label}`);
  } else {
    failed++;
    failures.push(`${label} — actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
    console.log(`FAIL ${label} — actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

// ---------------------------------------------------------------------------
// A. Cyrillic «Дн» === Latin «DN» (one size)
// ---------------------------------------------------------------------------
check('A1 extractDnValue("DN57") === 57', extractDnValue('DN57'), 57);
check('A2 extractDnValue("Дн57") === 57', extractDnValue('Дн57'), 57);
check('A3 Cyrillic Дн57 === Latin DN57', extractDnValue('Дн57'), extractDnValue('DN57'));
check('A4 extractDnValue("Дн57х3,5") === 57 (x-suffix tolerated)', extractDnValue('Труба Дн57х3,5'), 57);
check('A5 extractDnValue("DN-50") === 50 (separator tolerated)', extractDnValue('Кран DN-50'), 50);

// ---------------------------------------------------------------------------
// B. Production example: steel pipe «Дн57х3,5» must NOT match insulation
// ---------------------------------------------------------------------------
check(
  'B1 pipe Дн57х3,5 vs insulation ThermaECO -> mismatch',
  getStructuralScore('Труба стальная Дн57х3,5 ГОСТ 8732', 'Теплоизоляция ThermaECO P-60'),
  -1,
);

// ---------------------------------------------------------------------------
// C. Tee configuration: equal-pass «16-16-16» != transition «16-20-16»
// ---------------------------------------------------------------------------
check(
  'C1 tee 16-20-16 (transition) vs 16-16-16 (equal-pass) -> mismatch',
  getStructuralScore('Тройник переходной 16-20-16', 'Тройник равнопроходный 16-16-16'),
  -1,
);
check(
  'C2 tee 16-16-16 vs 16-16-16 -> match',
  getStructuralScore('Тройник равнопроходный 16-16-16', 'Тройник равнопроходный 16-16-16'),
  1,
);

// ---------------------------------------------------------------------------
// D. Fixator sizes 16 / 20 / 25 are distinguishable
// ---------------------------------------------------------------------------
check(
  'D1 fixator 16 vs 20 -> mismatch',
  getStructuralScore('Фиксатор поворота трубы 16', 'Фиксатор поворота трубы 20'),
  -1,
);
check(
  'D2 fixator 20 vs 25 -> mismatch',
  getStructuralScore('Фиксатор поворота трубы 20', 'Фиксатор поворота трубы 25'),
  -1,
);
check(
  'D3 fixator 16 vs 16 -> match',
  getStructuralScore('Фиксатор поворота трубы 16', 'Фиксатор поворота трубы 16'),
  1,
);

// ---------------------------------------------------------------------------
// E. Letter markings CV / CVL / C do not merge
// ---------------------------------------------------------------------------
check('E1 CV vs CVL -> mismatch', getStructuralScore('Клапан CV', 'Клапан CVL'), -1);
check('E2 CV vs C -> mismatch', getStructuralScore('Клапан CV', 'Клапан C'), -1);
check('E3 CV vs CV -> match', getStructuralScore('Клапан CV', 'Клапан CV'), 1);

// ---------------------------------------------------------------------------
// F. Guards — existing DN behaviour preserved (pass before AND after the fix)
// ---------------------------------------------------------------------------
check('F1 DN15 vs DN15 -> match', getStructuralScore('Кран DN15', 'Задвижка DN15'), 1);
check('F2 DN15 vs DN20 -> mismatch', getStructuralScore('Кран DN15', 'Задвижка DN20'), -1);
check('F3 DN15 vs (no DN) -> mismatch', getStructuralScore('Кран DN15', 'Задвижка шаровая'), -1);
check('F4 no discriminators -> neutral', getStructuralScore('Болт оцинкованный', 'Гайка оцинкованная'), 0);
check(
  'F5 same DN+cross, only GOST number differs -> match (GOST not a size)',
  getStructuralScore('Труба стальная Дн57х3,5 ГОСТ 8732-78', 'Труба стальная Дн57х3,5 ГОСТ 3262-75'),
  1,
);
check(
  'F6 spec Дн57, invoice bare 57 -> not penalized (same diameter, no -1)',
  getStructuralScore('Отвод Дн57', 'Отвод 57'),
  0,
);
check(
  'F7 cross agreement outranks dropped Дн prefix -> match',
  getStructuralScore('Труба Дн57х3,5', 'Труба 57х3,5'),
  1,
);

// ---------------------------------------------------------------------------
// G. extractMarkingFeatures spot checks (after the fix)
// ---------------------------------------------------------------------------
check('G1 config token', extractMarkingFeatures('Тройник 16-20-16').config, '16-20-16');
check('G2 cross token', extractMarkingFeatures('Труба Дн57х3,5').cross, '57x3.5');
check('G3 dn from cross-suffixed', extractMarkingFeatures('Труба Дн57х3,5').dn, 57);
check('G4 GOST number is not a bare size', extractMarkingFeatures('Труба Дн57х3,5 ГОСТ 8732-78').sizes, []);

// ===========================================================================
// FIX-ROUND 1 — bare numbers are a WEAK signal, not a veto.
// A bare-size conflict must NOT override agreement on a strong feature (DN /
// cross / config / letter mark); it still discriminates when nothing stronger
// spoke. Plus decimal-comma and article-code hygiene. Red before the fix.
// ===========================================================================

// H. Strong agreement is not killed by an insignificant bare number (cut length,
//    coil length). Cross/DN match -> still a match.
check(
  'H1 pipe Дн57х3,5 6000 vs 3000 (only cut length differs) -> match',
  getStructuralScore('Труба Дн57х3,5 6000', 'Труба Дн57х3,5 3000'),
  1,
);
check(
  'H2 cable 3х2,5 coil 100 vs 200 (only coil length differs) -> match',
  getStructuralScore('Кабель ВВГ 3х2,5 бухта 100', 'Кабель ВВГ 3х2,5 бухта 200'),
  1,
);

// I. Dimension PAIRS are a cross-section (strong, ordered, exact) regardless of
//    separator. A shared single side must NOT yield a false match.
check(
  'I1 radiator 3600 на 1200 vs 3000 на 1200 (pair = cross) -> mismatch',
  getStructuralScore('Радиатор 3600 на 1200', 'Радиатор 3000 на 1200'),
  -1,
);
check(
  'I2 radiator 3600x1200 vs 3000x1200 (symbol separator) -> mismatch',
  getStructuralScore('Радиатор 3600x1200', 'Радиатор 3000x1200'),
  -1,
);
check(
  'I3 radiator pair «на» === «*» (one entity) -> mismatch too',
  getStructuralScore('Радиатор 3600 на 1200', 'Радиатор 3000*1200'),
  -1,
);
check('I4 «3600 на 1200» extracts cross 3600x1200', extractMarkingFeatures('Радиатор 3600 на 1200').cross, '3600x1200');

// J. With NO strong feature, a bare number still discriminates (the number IS
//    the product — radiator height).
check(
  'J1 radiator 500 vs 600 (single height, no strong feature) -> mismatch',
  getStructuralScore('Радиатор 500', 'Радиатор 600'),
  -1,
);

// K. Decimal comma hygiene: a «,0 / ,5» tail must not leak as a bare size, and
//    rounding noise on a nominal DN must not fabricate a conflict.
check('K1 Дн108,0 -> dn 108', extractMarkingFeatures('Отвод Дн108,0').dn, 108);
check('K2 Дн108,0 -> no stray bare size', extractMarkingFeatures('Отвод Дн108,0').sizes, []);
check('K3 extractDnValue("Дн108,0") === 108', extractDnValue('Отвод Дн108,0'), 108);
check(
  'K4 Дн57,5 vs Дн57,8 (nominal DN rounding) -> no false conflict',
  getStructuralScore('Труба Дн57,5', 'Труба Дн57,8'),
  1,
);
check(
  'K5 Дн108,0х4,0 vs Дн108х4 (trailing-zero section) -> match',
  getStructuralScore('Труба Дн108,0х4,0', 'Труба Дн108х4'),
  1,
);
check('K6 Дн108,0х4,0 cross is 108x4 (no .0 fork)', extractMarkingFeatures('Труба Дн108,0х4,0').cross, '108x4');

// L. Article / catalog codes are an order reference, not a size — they must not
//    fabricate a bare-size conflict between two lines of the same product.
check(
  'L1 «арт. 123» vs «арт. 456» (catalog codes, not sizes) -> neutral',
  getStructuralScore('Заглушка арт. 123', 'Заглушка арт. 456'),
  0,
);
check('L2 «арт. 123» is not a bare size', extractMarkingFeatures('Заглушка арт. 123').sizes, []);

// M. Regression guard: letter markings still discriminate (not weakened).
check('M1 CV vs CVL still distinct', getStructuralScore('Клапан CV', 'Клапан CVL'), -1);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
