"""
Тест F5: guard совместимости multi-page carry маппинга.

Контекст: на счёте без заголовка на странице-продолжении парсер раньше СЛЕПО
переносил `page_mapping = prev_mapping` с предыдущей страницы. Если у continuation-
страницы РЕАЛЬНО другая раскладка колонок (другое число колонок / маппленные
числовые колонки пусты на этой странице), перенос не того маппинга → тихий
мис-маппинг qty/price/amount. Гейт (Move 2 C1) это флагнул.

Фикс F5 — `mapping_compatible_with_page(prev_mapping, page_data_rows)` —
СТРУКТУРНАЯ проверка (без хардкода поставщика/колонок):
  1. Ширина: строки-данные страницы достаточно широки, чтобы адресовать
     макс. индекс из prev_mapping (большинство строк длиннее max_idx).
  2. Числовая когерентность: каждая маппленная ЧИСЛОВАЯ колонка
     (quantity/price/amount) реально содержит числа на этой странице —
     ≥ половины классифицируемых строк дают parse_number в этой колонке.
Совместима → carry (как сейчас, чинит стр.2 счёта 47). Несовместима →
откат на per-page инференцию (старое поведение для нового грида) ВМЕСТО
слепого carry.

Консервативные края (намеренно True, чтобы поведение совпадало с до-guard
carry — guard только БЛОКИРУЕТ при позитивных уликах несовместимости):
  * нет строк-данных для суждения → True;
  * prev_mapping без числовых колонок → True (нечего валидировать).

⚠ Читаемого не-Ровен multi-page счёта в репо НЕТ (Элита garbled) → реальный
кросс-поставщик кейс здесь НЕ тестируется. Guard валидируется на синтетике +
оракуле Ровен 47 (стр.2 продолжение всё ещё carry'ится, отдельный тест
test_parser_roven_form_b.ts → 13/13).

Запуск: python -X utf8 scripts/test_carry_compatibility.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_invoice_table import (
    mapping_compatible_with_page,
    page_classifiable_data_rows,
)

failures = 0


def check(name, cond, details=''):
    global failures
    if cond:
        print(f'  PASS  {name}')
    else:
        print(f'  FAIL  {name}{(" -- " + details) if details else ""}')
        failures += 1


# Маппинг, «установленный заголовком» на стр.1 (как inv47 p1):
#   0=num 1=name 2=unit 3=quantity 4=price 5=amount  (max_idx=5, числовые 3/4/5)
PREV = {'num': 0, 'name': 1, 'unit': 2, 'quantity': 3, 'price': 4, 'amount': 5}


# ── (a) СОВМЕСТИМАЯ continuation-страница → True → carry ──
# Та же раскладка 6 колонок, числовые колонки 3/4/5 реально содержат числа.
print('(a) COMPAT: continuation с той же раскладкой → carry')
compat_rows = [
    ['11', 'Труба ПВХ 110',   'шт', '10', '500,00',  '5000,00'],
    ['12', 'Отвод 90°',       'шт', '25', '120,50',  '3012,50'],
    ['13', 'Муфта ремонтная', 'шт', '40', '85,00',   '3400,00'],
    ['14', 'Тройник',         'шт', '8',  '210,00',  '1680,00'],
]
check('(a) совместимая страница → True (carry применяется, как inv47 p2)',
      mapping_compatible_with_page(PREV, compat_rows) is True,
      'та же ширина + числовые 3/4/5 содержат числа')


# ── (b1) НЕсовместимая: ДРУГОЕ число колонок (уже prev_mapping) → False ──
# У страницы всего 3 колонки — max_idx=5 не существует на этой странице.
print('\n(b1) INCOMPAT: страница уже prev_mapping (нет колонки max_idx) → re-infer')
narrow_rows = [
    ['Наименование А', 'шт', '1000,00'],
    ['Наименование Б', 'шт', '2500,00'],
    ['Наименование В', 'шт', '3300,00'],
]
check('(b1) узкая страница (3 кол < max_idx 5) → False (откат на инференцию)',
      mapping_compatible_with_page(PREV, narrow_rows) is False,
      'ширины не хватает для адресации max_idx → carry НЕ применяется')


# ── (b2) НЕсовместимая: ширина та же, но маппленные числовые колонки ПУСТЫ ──
# 6 колонок, но числа лежат в ДРУГИХ колонках (сдвиг раскладки): колонки 3/4/5
# содержат текст/единицы, а числа — в 1/2/3. parse_number в 4 и 5 не находит чисел.
print('\n(b2) INCOMPAT: ширина ок, но числовые колонки prev пусты/нечисловые → re-infer')
shifted_rows = [
    ['Группа-1', '10', '5000,00', 'шт',  'примечание', 'код-А'],
    ['Группа-2', '25', '3012,50', 'шт',  'примечание', 'код-Б'],
    ['Группа-3', '40', '3400,00', 'упак', 'примечание', 'код-В'],
    ['Группа-4', '8',  '1680,00', 'шт',  'примечание', 'код-Г'],
]
check('(b2) числовые колонки prev (3/4/5) нечисловые на этой странице → False',
      mapping_compatible_with_page(PREV, shifted_rows) is False,
      'price(4)/amount(5) не содержат чисел → раскладка иная → carry НЕ применяется')


# ── (b3) НЕсовместимая: одна из числовых колонок пуста (половина не набирается) ──
print('\n(b3) INCOMPAT: amount-колонка пуста на >половине строк → re-infer')
amount_empty_rows = [
    ['1', 'Поз A', 'шт', '10', '500,00', ''],
    ['2', 'Поз B', 'шт', '25', '120,00', ''],
    ['3', 'Поз C', 'шт', '40', '85,00',  ''],
    ['4', 'Поз D', 'шт', '8',  '210,00', '1680,00'],
]
check('(b3) amount(5) число лишь в 1/4 строк (<½) → False',
      mapping_compatible_with_page(PREV, amount_empty_rows) is False,
      'маппленная числовая колонка не «числовая» на странице → carry НЕ применяется')


# ── Граница: достаточно >= половины строк числовые (порог ½) → True ──
print('\nThreshold: ровно ½ строк числовые в каждой числовой колонке → carry')
half_numeric_rows = [
    ['1', 'Поз A', 'шт', '10', '500,00', '5000,00'],
    ['2', 'Поз B', 'шт', '25', '120,00', '3000,00'],
    ['',  'итого подсекции пустая числовая часть', '', '', '', ''],
    ['',  'ещё одна текстовая строка без чисел в колонках', '', '', '', ''],
]
# 2 из 4 строк дают числа в 3/4/5 → порог max(1,(4+1)//2)=2 → выполняется.
check('THRESH: 2/4 строк числовые (порог 2) → True (carry)',
      mapping_compatible_with_page(PREV, half_numeric_rows) is True,
      'ровно порог ½ выполнен')


# ── Консервативные края (намеренно True — поведение до-guard carry) ──
print('\nEdges (намеренно True): нет строк / нет числовых колонок')
check('EDGE: пустой список строк → True (нечего опровергать)',
      mapping_compatible_with_page(PREV, []) is True)
check('EDGE: prev_mapping без числовых колонок → True (нечего валидировать)',
      mapping_compatible_with_page({'num': 0, 'name': 1, 'unit': 2}, narrow_rows) is True)
check('EDGE: пустой prev_mapping → False (нет грида для переноса)',
      mapping_compatible_with_page({}, compat_rows) is False)


# ── page_classifiable_data_rows: отбирает строки-данные как основной цикл ──
print('\npage_classifiable_data_rows: фильтрация строк-кандидатов')
mixed_table = [
    ['№', 'Наименование', 'Ед.', 'Кол-во', 'Цена', 'Сумма'],   # header → drop
    ['1', '2', '3', '4', '5', '6'],                              # col-number row → drop
    ['11', 'Труба ПВХ 110', 'шт', '10', '500,00', '5000,00'],   # data → keep
    ['', '', '', '', '', ''],                                    # пустая (combined<3) → drop
    ['x', '', '', '', '', ''],                                   # все ячейки <=2 → drop
    ['12', 'Отвод 90°', 'шт', '25', '120,50', '3012,50'],       # data → keep
]
kept = page_classifiable_data_rows(mixed_table)
check('CLASSIFY: оставлены только 2 строки-данные (header/col-num/шум отброшены)',
      len(kept) == 2, f'kept={len(kept)} ожидалось 2')
check('CLASSIFY: оставленные строки — настоящие позиции',
      kept and 'Труба' in ' '.join(kept[0]) and 'Отвод' in ' '.join(kept[1]))

# Сквозной мост: отфильтрованные строки совместимой таблицы → carry разрешён.
check('BRIDGE: page_classifiable_data_rows(совместимой) → compatible True',
      mapping_compatible_with_page(PREV, page_classifiable_data_rows(mixed_table)) is True,
      'после фильтра остаются числовые строки → carry')


print('')
if failures:
    print(f'{failures} assertion(s) FAILED')
    sys.exit(1)
print('All F5 carry-compatibility assertions passed')
