"""
Тест F1-дискриминатора: групповой подытог (ДРОП) vs сервис-строка (KEEP).

Контекст: на счетах РОВЕН (form B) встречаются строки-подытоги секций («ПЕ2»,
«ВЕ», «П1», «В1..В6», «Пенофол») — имя + сумма, пустая цена, нет №/ед. Их нужно
выбрасывать ДО инференса колонок и извлечения. Но «в изоляции» такой подытог
НЕОТЛИЧИМ от легитимной lump-sum сервис-строки («Доставка», «Монтаж» — имя + сумма,
пустая цена, qty=1, без ед., без №). Старый single-row `is_group_subheader_row`
дропал ОБЕ → терялись реальные «Доставка»/«Монтаж».

Фикс F1 — `confirm_group_subheader_row(table, row_index, mapping)` — контекстная
проверка: подытог дропается ТОЛЬКО если его `amount ≈ Σ(amount следующих
member-строк)` до границы секции (следующий групп-подытог / summary). Иначе:
  * member_count == 0 (нет members — трейлинг-сервис или сервис перед границей) → KEEP;
  * обрыв таблицы/страницы с member_count ≥ 1 (секция РОВЕН разрезана переносом
    страницы, сумму не проверить) → DROP (legacy);
  * чистая граница и Σ(members) ≉ amount → KEEP (это несвязанные соседи, не члены).

Этот тест — единственная защита того, что «Доставка»/«Монтаж» НЕ будут съедены,
и одновременно что РОВЕН-подытоги всё ещё дропаются (оракул Ровен 47).

Запуск: python -X utf8 scripts/test_group_discriminator.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_invoice_table import (
    confirm_group_subheader_row,
    is_group_subheader_row,
    is_summary_row,
)

failures = 0


def check(name, cond, details=''):
    global failures
    if cond:
        print(f'  PASS  {name}')
    else:
        print(f'  FAIL  {name}{(" -- " + details) if details else ""}')
        failures += 1


# Реальные ключи маппинга из extract_invoice_table.py:
#   num, article, name, unit, quantity, price, amount
# Колоночная раскладка синтетических таблиц (article опускаем — он опционален):
#   0=num  1=name  2=unit  3=quantity  4=price  5=amount
M = {'num': 0, 'name': 1, 'unit': 2, 'quantity': 3, 'price': 4, 'amount': 5}


# ── Sanity: single-row предикат НЕ различает подытог и сервис-строку ──
# Это и есть причина существования confirm_*: оба выглядят одинаково «в изоляции».
print('Sanity: single-row is_group_subheader_row неоднозначен')
delivery_row = ['', 'Доставка', '', '1', '', '1500,00']
subtotal_row = ['', 'ПЕ2', '', '', '', '10000,00']
check('sanity: «Доставка» триггерит single-row предикат (ambiguity)',
      is_group_subheader_row(delivery_row, M) is True)
check('sanity: «ПЕ2» подытог триггерит single-row предикат',
      is_group_subheader_row(subtotal_row, M) is True)
check('sanity: «Итого» распознаётся как summary (граница секции)',
      is_summary_row(['', 'Итого', '', '', '', '50000,00'], M) is True)
check('sanity: нормальная позиция (с ценой) НЕ групп-строка',
      is_group_subheader_row(['1', 'Труба ПВХ', 'шт', '10', '500,00', '5000,00'], M) is False)


# ── DROP: РОВЕН-подобный групп-подытог с подтверждающими member-строками ──
# Метка-подытог (amount=3000, цена пуста) + 2 member-строки (Σ amount = 3000),
# затем summary → confirm = True (дроп).
print('\nDROP: групп-подытог, Σ(members) == amount, чистая граница')
t_drop = [
    ['',  'Группа ПЕ2', '',   '',   '',       '3000,00'],   # 0: подытог 3000
    ['1', 'Профиль А',  'шт', '10', '100,00', '1000,00'],   # member 1000
    ['2', 'Профиль Б',  'шт', '20', '100,00', '2000,00'],   # member 2000 → Σ=3000
    ['',  'Итого',      '',   '',   '',       '3000,00'],   # summary граница
]
check('DROP: подытог дропается (Σ members 3000 == amount 3000)',
      confirm_group_subheader_row(t_drop, 0, M) is True,
      'групп-подытог должен быть подтверждён и выброшен')


# ── KEEP сервис-в-конце: «Доставка» перед «Итого» (member_count == 0) ──
print('\nKEEP: «Доставка» в конце перед summary (нет members)')
t_keep_end = [
    ['1', 'Труба',    'шт', '10', '500,00', '5000,00'],
    ['',  'Доставка', '',   '1',  '',       '1500,00'],     # 1: сервис, дальше summary
    ['',  'Итого',    '',   '',   '',       '6500,00'],
]
check('KEEP: «Доставка»@конец удержана (member_count==0)',
      confirm_group_subheader_row(t_keep_end, 1, M) is False,
      'легит сервис-строка не должна дропаться')


# ── KEEP сервис-в-середине: «Доставка» (1500), дальше позиции с Σ != 1500 ──
print('\nKEEP: «Доставка» в середине, Σ(следующих) != amount')
t_keep_mid = [
    ['',  'Доставка', '',   '1', '',        '1500,00'],     # 0: сервис 1500
    ['1', 'Насос',    'шт', '2', '9000,00', '18000,00'],    # 18000
    ['2', 'Кран',     'шт', '4', '750,00',  '3000,00'],     # 3000 → Σ=21000 != 1500
    ['',  'Итого',    '',   '',  '',        '22500,00'],
]
check('KEEP: «Доставка»@середина удержана (Σ соседей 21000 != 1500)',
      confirm_group_subheader_row(t_keep_mid, 0, M) is False,
      'сумма соседей не совпала с amount → это не подытог')


# ── KEEP «Монтаж» lump-sum перед summary (member_count == 0) ──
print('\nKEEP: «Монтаж» lump-sum перед summary')
t_keep_montazh = [
    ['1', 'Оборудование',   'шт', '1', '50000,00', '50000,00'],
    ['',  'Монтаж',         '',   '1', '',         '8000,00'],   # 1: сервис, дальше summary
    ['',  'Всего к оплате', '',   '',  '',         '58000,00'],
]
check('KEEP: «Монтаж» lump-sum удержан (member_count==0)',
      confirm_group_subheader_row(t_keep_montazh, 1, M) is False)


# ── KEEP: «Доставка» как ПОСЛЕДНЯЯ строка таблицы (нет summary после) ──
# member_count==0, ended_cleanly остаётся False, НО ветка cnt==0 проверяется
# первой → KEEP. Документируем, что трейлинг-сервис без summary не теряется.
print('\nKEEP: «Доставка» как последняя строка таблицы')
t_last = [
    ['1', 'Труба',    'шт', '10', '500,00', '5000,00'],
    ['',  'Доставка', '',   '1',  '',       '1500,00'],     # 1: последняя строка
]
check('KEEP: «Доставка»@последняя строка удержана (cnt==0 раньше not-ended)',
      confirm_group_subheader_row(t_last, 1, M) is False)


# ── KEEP: «Доставка» сразу перед групп-меткой (граница, member_count == 0) ──
print('\nKEEP: «Доставка» прямо перед групп-меткой')
t_before_group = [
    ['',  'Доставка',  '',   '1',  '',       '1500,00'],    # 0: сервис
    ['',  'Группа В2', '',   '',   '',       '9000,00'],    # групп-граница сразу
    ['1', 'Элемент',   'шт', '90', '100,00', '9000,00'],
    ['',  'Итого',     '',   '',   '',       '10500,00'],
]
check('KEEP: «Доставка» перед групп-меткой удержана (cnt==0 на границе)',
      confirm_group_subheader_row(t_before_group, 0, M) is False)


# ── Edge (НАМЕРЕННО legacy DROP): подытог + members, оборванные концом таблицы ──
# not ended_cleanly И member_count >= 1 (секция РОВЕН разрезана переносом
# страницы) → сумму нельзя проверить → fall back на legacy DROP.
print('\nEDGE (намеренный legacy DROP): подытог оборван концом таблицы')
t_edge = [
    ['',  'Группа В1', '',   '',   '',       '4000,00'],    # 0: подытог
    ['1', 'Элемент',   'шт', '10', '100,00', '1000,00'],    # member, дальше обрыв таблицы
]
check('EDGE: оборванный подытог дропается (legacy, член есть, границы нет)',
      confirm_group_subheader_row(t_edge, 0, M) is True,
      'not ended_cleanly + member_count>=1 → legacy drop')


# ── Tolerance guards (GROUP_SUBTOTAL_TOL_FRAC = 2%) ──
print('\nTolerance: 2% порог подтверждения подытога')
# В пределах 2% → DROP
t_tol_in = [
    ['',  'Группа П1', '',   '',  '',        '10000,00'],
    ['1', 'A',         'шт', '1', '5050,00', '5050,00'],
    ['2', 'B',         'шт', '1', '5000,00', '5000,00'],    # Σ=10050 vs 10000 → 0.5%
    ['',  'Итого',     '',   '',  '',        '10050,00'],
]
check('TOL: Σ в пределах 2% → DROP (10050 vs 10000)',
      confirm_group_subheader_row(t_tol_in, 0, M) is True)
# За пределами 2% → KEEP (несвязанные соседи)
t_tol_out = [
    ['',  'Группа П2', '',   '',  '',        '10000,00'],
    ['1', 'A',         'шт', '1', '5000,00', '5000,00'],
    ['2', 'B',         'шт', '1', '8000,00', '8000,00'],    # Σ=13000 vs 10000 → 30%
    ['',  'Итого',     '',   '',  '',        '23000,00'],
]
check('TOL: Σ за пределами 2% → KEEP (13000 vs 10000, несвязанные соседи)',
      confirm_group_subheader_row(t_tol_out, 0, M) is False)


# ── Guard: нормальная позиция (с ценой) НЕ дропается даже в контексте ──
print('\nGuard: позиция с ценой не дропается')
t_priced = [
    ['1', 'Насос ANTARUS', 'шт', '2', '9000,00', '18000,00'],   # 0: настоящая позиция
    ['2', 'Кран',          'шт', '4', '750,00',  '3000,00'],
    ['',  'Итого',         '',   '',  '',        '21000,00'],
]
check('GUARD: позиция с unit-price не дропается (is_group_subheader=False)',
      confirm_group_subheader_row(t_priced, 0, M) is False)


print('')
if failures:
    print(f'{failures} assertion(s) FAILED')
    sys.exit(1)
print('All F1 group-discriminator assertions passed')
