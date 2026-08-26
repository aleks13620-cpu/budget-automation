/**
 * Классификатор позиций спецификации: перенос из price-harvester/research/klassifikator_pozicij.py.
 * Фиксирует характерные случаи ИЗ РЕАЛЬНЫХ ДАННЫХ (спецификации 34 и 19 базы
 * database/budget_automation.db, id строк указаны) — чтобы правила не «поплыли» при правках.
 *
 * Полная сверка с python-эталоном (7039 строк базы, 0 расхождений) делалась разово
 * в scratchpad; здесь — её выжимка, которая гоняется без БД и без python.
 *
 * Запуск:  cd backend && npx ts-node test_spec_classifier.ts
 */
import { classifySpecItem, buildFullName, trimSizeTail } from './src/services/specClassifier';
import type { SpecItemRow } from './src/services/specClassifier';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got === undefined ? '' : `  получено: ${JSON.stringify(got)}`}`); }
}

function row(o: Partial<SpecItemRow>): SpecItemRow {
  return { id: o.id ?? 0, name: null, product_code: null, characteristics: null,
    manufacturer: null, marking: null, article: null, full_name: null,
    parent_item_id: null, quantity: 1, ...o };
}

/** Позиция классифицируется по собранному полному имени; здесь оно = name (родителей нет). */
function cls(r: SpecItemRow) {
  return classifySpecItem(r, buildFullName(r, new Map()));
}

const cases: Array<{ label: string; row: SpecItemRow; group: string; mark: string | null; src: string | null }> = [
  {
    label: 'id 7417 — артикул в product_code («SonoSelect 10»)',
    row: row({ id: 7417, name: 'Теплосчетчик поквартирный, qp=1.5м3/ч; Ø15',
      product_code: 'SonoSelect 10', characteristics: '', manufacturer: 'РИДАН' }),
    group: 'C. марка изделия', mark: 'SonoSelect 10', src: 'product_code',
  },
  {
    label: 'id 7418 — типоразмер радиатора C22-400-600 тоже марка',
    row: row({ id: 7418, name: 'Радиатор панельный Compact',
      product_code: 'C22-400-600', characteristics: '', manufacturer: 'EVRA' }),
    group: 'C. марка изделия', mark: 'C22-400-600', src: 'product_code',
  },
  {
    label: 'id 7565 — Ду/Ру/Тmax это типоразмер, а не марка → D',
    row: row({ id: 7565, name: 'Воздушник BVS-R/Ду15/Ру63/Тmax180 нерж.сталь р/р',
      product_code: 'BVS-R', characteristics: '', manufacturer: 'Ридан' }),
    group: 'D. без марки', mark: null, src: null,
  },
  {
    label: 'id 7564 — DN65/PN16/Tmax150 это типоразмер → D',
    row: row({ id: 7564, name: 'Грязевик DN65/PN16/Tmax150 сталь ф/ф', characteristics: '' }),
    group: 'D. без марки', mark: null, src: null,
  },
  {
    label: 'id 7414 — «в составе:» → проектное, марка при этом найдена',
    row: row({ id: 7414, characteristics: '',
      name: 'Узел этажный распред. на 5 кв.; в составе: - вводные шаровые краны - сетчатый фильтр',
      product_code: 'TDU.5R DN50-5 R-32- MVT25-APT25-MVT15', manufacturer: 'РИДАН' }),
    group: 'B. проектное', mark: 'MVT 25', src: 'product_code',
  },
  {
    label: 'id 1025 — воздуховод по ГОСТ 14918 → изготавливается, ГОСТ не марка',
    row: row({ id: 1025, name: 'Воздуховод из оцинк. стали по ГОСТ 14918-2020 S=0,8мм Ø200',
      characteristics: 'Воздуховод из оцинк. стали по ГОСТ 14918-2020 S=0,8мм Ø200' }),
    group: 'A. изготавливается', mark: null, src: null,
  },
  {
    label: 'id 7470 — «из оцинк. стали толщиной» → A; ГОСТ в product_code маркой не считается',
    row: row({ id: 7470, name: 'Воздуховод из оцинк. стали толщиной S=1.1мм Ø1000',
      product_code: 'ГОСТ 14918-90', characteristics: '' }),
    group: 'A. изготавливается', mark: null, src: null,
  },
  {
    label: 'id 6207 — «ТУ5769-015-...» слитно: граница слова НЕ срабатывает, это марка',
    row: row({ id: 6207, characteristics: '',
      name: 'Огнезащитные маты на основе базальтового супертонкого штапельного волокна (БСТВ) без связующего б=20мм',
      marking: 'ТУ5769-015-54737814-2008' }),
    group: 'C. марка изделия', mark: 'ТУ5769-015-54737814-2008', src: 'marking',
  },
  {
    label: 'id 7433 — описание комплекта без артикула → D',
    row: row({ id: 7433, characteristics: '', manufacturer: 'РИДАН',
      name: 'Комплект подключения: - комплект клапанов для нижнего подключения прямой LV-KB - термостатический элемент TR 84' }),
    group: 'D. без марки', mark: null, src: null,
  },
];

console.log('=== позиции из реальных спецификаций ===');
for (const c of cases) {
  const r = cls(c.row);
  check(c.label, r.group === c.group && r.mark === c.mark && r.markSrc === c.src,
    { group: r.group, mark: r.mark, src: r.markSrc });
}

// --- отдельно: куски, где python и JS расходятся по умолчанию ---
console.log('\n=== перенос регулярок (кириллица в \\b и \\w) ===');
// ГОСТ с пробелом перед номером — граница слова есть, значит НЕ марка (наивный JS-ный \b тут врёт)
check('«ГОСТ 14918-90» не марка', cls(row({ name: 'Труба', product_code: 'ГОСТ 14918-90' })).mark === null);
// а слитное «ТУ5769…» — граница слова отсутствует, это марка
check('«ТУ5769-015-54737814-2008» марка',
  cls(row({ name: 'Маты', marking: 'ТУ5769-015-54737814-2008' })).mark === 'ТУ5769-015-54737814-2008');
// «оцинк\w*» из python требует юникодного \w — ASCII-шный \w не дотянет до «ованной»
check('«из оцинкованной стали толщиной» → A',
  cls(row({ name: 'Короб из оцинкованной стали толщиной 0,7 мм' })).group === 'A. изготавливается');

console.log('\n=== хвост типоразмера ===');
check('BVS-R/Dy25/Py63/Tmax180 → BVS-R', trimSizeTail('BVS-R/Dy25/Py63/Tmax180') === 'BVS-R',
  trimSizeTail('BVS-R/Dy25/Py63/Tmax180'));
check('O80мм 0 → пусто', trimSizeTail('O80мм 0') === '', trimSizeTail('O80мм 0'));

console.log('\n=== полное имя по родителям ===');
const parent = row({ id: 1, name: 'Клапан противопожарный' });
const child = row({ id: 2, name: 'КПУ-1М', parent_item_id: 1 });
const byId = new Map<number, SpecItemRow>([[1, parent], [2, child]]);
check('имя ребёнка склеено с родителем',
  buildFullName(child, byId) === 'Клапан противопожарный КПУ-1М', buildFullName(child, byId));
check('склейка родителя даёт группу B',
  classifySpecItem(child, buildFullName(child, byId)).group === 'B. проектное');

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
