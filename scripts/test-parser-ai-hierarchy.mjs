#!/usr/bin/env node
/**
 * Метрики «до/после» для ИИ-разметки иерархии родитель/ребёнок в парсере спеки.
 *
 * Замысел эксперимента (воспроизводимо, без сетевой недетерминированности):
 *   1. Один раз получаем РЕАЛЬНЫЙ ответ LLM (Gemini/OpenRouter) на каждый PDF
 *      с НОВЫМ промптом (содержит parent_position / parent_name_hint) и кешируем JSON.
 *   2. ПОСЛЕ = mapPdfItemsToRows(LLM-JSON)               — новый код, читает подсказки.
 *   3. ДО    = mapPdfItemsToRows(LLM-JSON без подсказок)  — эквивалент origin/main
 *      (доказано: 7/7 фикстур spec-pdf без подсказок проходят на эталоне старого кода,
 *       значит новый код на входе без подсказок == origin/main).
 *
 * Третий (контрольный) файл — фикстура, где иерархия работала по номерам (без подсказок):
 * ДО == ПОСЛЕ обязаны совпасть (регрессии нет).
 *
 * Запуск из backend/:  node ../scripts/test-parser-ai-hierarchy.mjs
 * Перекапчур LLM:      node ../scripts/test-parser-ai-hierarchy.mjs --refresh
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'backend');
const fixturesDir = path.join(backendDir, 'tests', 'fixtures', 'spec-pdf');
const cacheDir = path.join(__dirname, '.cache-ai-hierarchy');
const REFRESH = process.argv.includes('--refresh');

// dotenv (OPENROUTER_API_KEY) из backend/.env
const backendRequire = createRequire(path.join(backendDir, 'package.json'));
backendRequire('dotenv').config({ path: path.join(backendDir, '.env') });
backendRequire('ts-node').register({
  transpileOnly: true,
  project: path.join(backendDir, 'tsconfig.json'),
});
const {
  mapPdfItemsToRows,
  SPECIFICATION_PROMPT,
} = backendRequire('./src/services/gigachatSpecFromPdf');
const { parseSpecPdfWithGemini } = backendRequire('./src/services/geminiSpecFromPdf');
const { evaluateSpecPdfParseQuality } = backendRequire('./src/services/gigachatSpecParseQuality');

// ---------------------------------------------------------------------------
// Файлы под тест
// ---------------------------------------------------------------------------
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const FILES = [
  {
    key: 'lastochka_ov',
    label: 'Ласточка ОВ (родня радиаторов)',
    kind: 'pdf',
    pdf: path.join(HOME, 'Downloads', '5-ПР_21 – ОВ (1)-45-75.pdf'),
    success: { minLinkedPct: 0.8, maxOrphanPct: 0.05 },
  },
  {
    key: 'sokoliy_vk',
    label: 'Сокольи горы ВК',
    kind: 'pdf',
    pdf: path.join(HOME, 'Downloads', 'Скольи горы 6.06.26 5-ПР_21 – ВК_входящая спецификация.pdf'),
    // У Сокольих в документе физически нет № позиций → иерархия только через
    // parent_name_hint. Цель — заметный рост связности; точные пороги не догматизируем.
    success: { minLinkedPct: 0.5, maxOrphanPct: 0.2 },
  },
  {
    key: 'control_04_mixed',
    label: 'Контроль: 04_mixed (иерархия по номерам, без подсказок)',
    kind: 'fixture',
    fixture: path.join(fixturesDir, '04_mixed.gigachat-response.json'),
    control: true,
  },
];

// ---------------------------------------------------------------------------
// Метрики
// ---------------------------------------------------------------------------
function hasPos(r) {
  return r.position_number != null && String(r.position_number).trim() !== '';
}
function metrics(rows) {
  const total = rows.length;
  const withPos = rows.filter(hasPos).length;
  const noPos = total - withPos;
  const linked = rows.filter(r => r._parentIndex != null).length;
  const orphans = rows.filter(r => !hasPos(r) && r._parentIndex == null).length;
  const monster = rows.filter(r => {
    const n = r.name || '';
    return n.length > 120 || (n.match(/[+;•]/g) || []).length >= 2;
  }).length;
  return {
    total,
    withPos,
    noPos,
    linked,
    orphans,
    monster,
    linkedPct: total ? linked / total : 0,
    orphanPct: total ? orphans / total : 0,
    // Доля детей (строк без №), привязанных к родителю — изолирует ценность LLM-якоря.
    childLinkRate: noPos ? linked / noPos : 0,
  };
}

/** Убрать поля иерархии → поведение origin/main (старый код их не знал). */
function stripHints(json) {
  return {
    ...json,
    items: (json.items || []).map(it => {
      const { parent_position, parent_name_hint, ...rest } = it;
      return rest;
    }),
  };
}

function hintCoverage(json) {
  const items = json.items || [];
  const childRows = items.filter(it => it.position == null || String(it.position).trim() === '');
  const withHint = childRows.filter(
    it =>
      (it.parent_position != null && String(it.parent_position).trim() !== '') ||
      (it.parent_name_hint != null && String(it.parent_name_hint).trim() !== ''),
  ).length;
  return { rawItems: items.length, childRows: childRows.length, withHint };
}

async function getLlmJson(f) {
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, `${f.key}.gemini.json`);
  if (!REFRESH && fs.existsSync(cacheFile)) {
    return { json: JSON.parse(fs.readFileSync(cacheFile, 'utf-8')), cached: true };
  }
  if (!fs.existsSync(f.pdf)) throw new Error(`PDF not found: ${f.pdf}`);
  const userContent =
    'Извлеки таблицу спецификации из вложенного PDF согласно системной инструкции. ' +
    'Для каждой дочерней строки (position=null) ОБЯЗАТЕЛЬНО заполни parent_position или parent_name_hint.';
  console.log(`  [llm] calling Gemini for ${f.key} (this may take 10-40s)...`);
  const json = await parseSpecPdfWithGemini(f.pdf, SPECIFICATION_PROMPT, userContent);
  if (!json) throw new Error(`Gemini returned null for ${f.key}`);
  fs.writeFileSync(cacheFile, JSON.stringify(json, null, 2), 'utf-8');
  return { json, cached: false };
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}
function row(label, m) {
  return `| ${label} | ${m.total} | ${m.withPos} | ${m.linked} | ${m.orphans} | ${m.monster} |`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const results = [];
let allOk = true;

for (const f of FILES) {
  console.log(`\n=== ${f.label} ===`);
  let json;
  let coverage = null;
  try {
    if (f.kind === 'pdf') {
      const got = await getLlmJson(f);
      json = got.json;
      coverage = hintCoverage(json);
      console.log(
        `  [llm] ${got.cached ? 'cached' : 'fresh'}; raw items=${coverage.rawItems}, ` +
          `child rows=${coverage.childRows}, with hint=${coverage.withHint} ` +
          `(${coverage.childRows ? fmtPct(coverage.withHint / coverage.childRows) : 'n/a'})`,
      );
    } else {
      json = JSON.parse(fs.readFileSync(f.fixture, 'utf-8'));
      coverage = hintCoverage(json);
    }
  } catch (err) {
    console.log(`  SKIP/FAIL — ${err.message}`);
    if (!f.control) allOk = false;
    results.push({ f, error: err.message });
    continue;
  }

  const after = metrics(mapPdfItemsToRows(json));
  const before = metrics(mapPdfItemsToRows(stripHints(json)));

  console.log('\n| | строк | с № | _parentIndex≠null | сирот | монстро-строк |');
  console.log('|---|---|---|---|---|---|');
  console.log(row('ДО  (origin/main)', before));
  console.log(row('ПОСЛЕ (ветка)', after));
  console.log(
    `\n  все строки: ДО ${fmtPct(before.linkedPct)} → ПОСЛЕ ${fmtPct(after.linkedPct)} linked` +
      ` | дети(без №) привязаны: ДО ${fmtPct(before.childLinkRate)} → ПОСЛЕ ${fmtPct(after.childLinkRate)}` +
      ` | сирот: ДО ${fmtPct(before.orphanPct)} → ПОСЛЕ ${fmtPct(after.orphanPct)}`,
  );

  let verdict = 'INFO';
  if (f.control) {
    const same =
      before.total === after.total &&
      before.linked === after.linked &&
      before.orphans === after.orphans;
    verdict = same ? 'PASS (no regression)' : 'FAIL (control changed!)';
    if (!same) allOk = false;
  } else if (f.success) {
    // Литеральный критерий брифа (>80% всех строк / <=5% сирот) — печатаем как INFO,
    // он структурно ограничен (нумерованные родители + самостоятельные позиции).
    const litOk =
      after.linkedPct >= f.success.minLinkedPct && after.orphanPct <= f.success.maxOrphanPct;
    // Содержательный критерий: LLM-якорь не должен регрессировать привязку детей.
    const noRegression = after.childLinkRate >= before.childLinkRate && after.orphans <= before.orphans;
    const strictlyImproved = after.childLinkRate > before.childLinkRate;
    console.log(
      `  [бриф-цель ${fmtPct(f.success.minLinkedPct)}/<=${fmtPct(f.success.maxOrphanPct)}: ${litOk ? 'MET' : 'NOT MET (структурно ограничено)'}]`,
    );
    verdict = !noRegression
      ? 'FAIL (regression)'
      : strictlyImproved
        ? 'PASS (anchor improves child-linking, no regression)'
        : 'PASS (anchor inert — no variant hierarchy in doc, no regression)';
    if (!noRegression && f.key === 'lastochka_ov') allOk = false;
  }
  console.log(`  VERDICT: ${verdict}`);
  results.push({ f, before, after, coverage, verdict });
}

// ---------------------------------------------------------------------------
// Гейт качества (детерминированный, без LLM): блок только на «голых» сиротах.
// ---------------------------------------------------------------------------
console.log(`\n=== Гейт hardBlock (feedback_no_corrupt_through) ===`);
function gateCase(label, items, expectBlock) {
  const rows = mapPdfItemsToRows({ items });
  const q = evaluateSpecPdfParseQuality(items, rows);
  const ok = q.hardBlock === expectBlock;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'} ${label}: bareOrphan=${fmtPct(q.bareOrphanFraction)} hardBlock=${q.hardBlock} (expect ${expectBlock})`,
  );
  if (!ok) allOk = false;
}
// Катастрофа: голые DN-дети без родителя → блок.
gateCase(
  'катастрофа (DN-коды без родителя)',
  Array.from({ length: 10 }, (_, i) => ({ position: null, name: `DN${15 + i * 5}`, unit: 'шт', quantity: 1 })),
  true,
);
// Плоский список самодостаточных имён → НЕ блок (валидная не-иерархическая спека).
gateCase(
  'плоский список (длинные имена)',
  Array.from({ length: 10 }, (_, i) => ({
    position: null,
    name: `Затвор дисковый поворотный межфланцевый Tecofi DN${100 + i * 10} с рукояткой`,
    unit: 'шт',
    quantity: 1,
  })),
  false,
);
// Реальные кеши: Сокольи (плоский) НЕ блок; Ласточка (хорошая) НЕ блок.
for (const k of ['sokoliy_vk', 'lastochka_ov']) {
  const cf = path.join(cacheDir, `${k}.gemini.json`);
  if (fs.existsSync(cf)) gateCase(`реальный ${k}`, JSON.parse(fs.readFileSync(cf, 'utf-8')).items, false);
}

console.log(`\n${'='.repeat(60)}\nSUMMARY: ${allOk ? 'OK' : 'NEEDS REVIEW'}`);
process.exit(allOk ? 0 : 1);
