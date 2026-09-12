/**
 * Заголовок узла не товар — зеркало _selfcheck() из klassifikator_pozicij.py.
 * Правило живёт в двух реализациях; сверка по базе его не ловит, пока в базе нет
 * ни одной такой строки (12.09: во всей локальной базе их 0, они только на проде).
 */
import { classifySpecItem } from './src/services/specClassifier';

type Row = Parameters<typeof classifySpecItem>[0];
const row = (kw: Partial<Row>): Row =>
  ({ name: null, product_code: null, characteristics: null, manufacturer: null,
     marking: null, article: null, full_name: null, ...kw }) as Row;

let failed = 0;
const check = (what: string, got: string, want: string) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}: ${got}`);
};

const hdr1 = row({ name: 'Спецификация элементов стояка К1.1', marking: 'К1.1' });
const hdr2 = row({ name: 'Спецификация элементов узла ввода в квартиру', marking: 'ОА-06-03-2024-ВК - Лист 2' });
const kid = row({ name: 'Клапан обратный осевой муфтовый', marking: 'CA1103-0025' });
const other = row({ name: 'Шкаф по спецификации заказчика', marking: 'ШГ-1200' });

check('заголовок со стояком К1.1', classifySpecItem(hdr1, hdr1.name!).group, 'D. без марки');
check('заголовок с шифром проекта', classifySpecItem(hdr2, hdr2.name!).group, 'D. без марки');
check('дочерняя позиция под заголовком',
  classifySpecItem(kid, 'Спецификация элементов стояка К1.1 Клапан обратный').group, 'C. марка изделия');
check('слово внутри строки заголовком не делает', classifySpecItem(other, other.name!).group, 'C. марка изделия');

console.log(failed === 0 ? '==== 4 passed, 0 failed ====' : `==== ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
