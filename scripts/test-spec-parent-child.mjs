#!/usr/bin/env node

/**
 * Regression runner for spec-pdf variant-children (PRB-008).
 *
 * Feeds synthetic GigaChat response JSON through mapPdfItemsToRows (CURRENT code)
 * and compares output against expected.json. Red-first — expected to FAIL on
 * case 01 until the fix is applied.
 *
 * Usage: node scripts/test-spec-parent-child.mjs
 *        npm run test:spec-pdf          (from backend/)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixturesDir = path.join(repoRoot, 'backend', 'tests', 'fixtures', 'spec-pdf');

// ---------------------------------------------------------------------------
// ts-node bootstrap (CommonJS module with TypeScript)
// ---------------------------------------------------------------------------
const backendPkg = path.join(repoRoot, 'backend', 'package.json');
const backendRequire = createRequire(backendPkg);
backendRequire('ts-node').register({
  transpileOnly: true,
  project: path.join(repoRoot, 'backend', 'tsconfig.json'),
});
const { mapPdfItemsToRows } = backendRequire('./src/services/gigachatSpecFromPdf');

// ---------------------------------------------------------------------------
// Test cases (must match fixture file prefixes)
// ---------------------------------------------------------------------------
const CASES = [
  '01_radiator_variants_no_position',
  '02_dn_children',
  '03_to_zhe_children',
  '04_mixed',
  '05_negative_no_parent_variant',
  '06_dn_false_positive',
  '07_parameterized_false_positive',
];

// ---------------------------------------------------------------------------
// Deep equality helper
// ---------------------------------------------------------------------------
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => deepEqual(a[k], b[k]));
}

// ---------------------------------------------------------------------------
// Diff printer
// ---------------------------------------------------------------------------
function printDiff(actual, expected) {
  const maxLen = Math.max(actual.length, expected.length);
  const diffs = [];
  for (let i = 0; i < maxLen; i++) {
    const a = actual[i];
    const e = expected[i];
    if (!a && e) {
      diffs.push(`  row[${i}]: MISSING — expected ${JSON.stringify(e)}`);
    } else if (a && !e) {
      diffs.push(`  row[${i}]: EXTRA — actual ${JSON.stringify(a)}`);
    } else if (a && e) {
      const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
      for (const key of keys) {
        if (!deepEqual(a[key], e[key])) {
          diffs.push(
            `  row[${i}].${key}: actual=${JSON.stringify(a[key])} expected=${JSON.stringify(e[key])}`,
          );
        }
      }
    }
  }
  if (diffs.length === 0) {
    console.log(`  (no structural diff, but deep equality failed)`);
  } else {
    for (const d of diffs) {
      console.log(d);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

for (const caseName of CASES) {
  const responsePath = path.join(fixturesDir, `${caseName}.gigachat-response.json`);
  const expectedPath = path.join(fixturesDir, `${caseName}.expected.json`);

  if (!fs.existsSync(responsePath)) {
    console.log(`SKIP ${caseName} — missing gigachat-response.json`);
    continue;
  }
  if (!fs.existsSync(expectedPath)) {
    console.log(`SKIP ${caseName} — missing expected.json`);
    continue;
  }

  let gigachatResponse;
  let expected;
  try {
    gigachatResponse = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
  } catch (err) {
    console.log(`FAIL ${caseName} — invalid fixture JSON: ${err.message}`);
    failed++;
    continue;
  }

  let actual;
  try {
    actual = mapPdfItemsToRows(gigachatResponse);
  } catch (err) {
    console.log(`FAIL ${caseName} — mapPdfItemsToRows threw: ${err.message}`);
    failed++;
    continue;
  }

  if (deepEqual(actual, expected)) {
    console.log(`PASS ${caseName}`);
    passed++;
  } else {
    console.log(`FAIL ${caseName}`);
    printDiff(actual, expected);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed}/${CASES.length} passed`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
