"""
Нормализация наименований инженерки — лёгкий порт логики из backend matcher.ts,
ровно настолько, чтобы СОПОСТАВИТЬ предложение из фида с позицией спецификации:
канонизация DN/Ду/Дн/ø, разделителей размеров (500х300→500x300), запятой в дробях,
снятие ГОСТ/ТУ-скобок, стоп-слова, биграммная мера схожести (как string-similarity).

Это НЕ замена матчеру бэкенда — это локальный скоринг для пилота, чтобы привязать
найденную цену к нужной позиции. Боевой матчинг остаётся в backend (его не трогаем).
"""
from __future__ import annotations

import re
from collections import Counter

_DEC = re.compile(r"(\d),(\d)")
_GOST = re.compile(r"\([^)]*(?:гост|ту)\s*[\d\s\-\./]*[^)]*\)", re.I)

STOP = {
    "мм", "см", "м", "шт", "кг", "г", "л", "мл", "компл", "комплект", "набор",
    "ед", "пог", "кв", "куб", "п", "к", "и", "в", "с", "на", "для", "из", "по", "от", "до",
}


def _canon_engineering(s: str) -> str:
    s = s.lower().replace("ё", "е")
    s = _DEC.sub(r"\1.\2", s)                                   # 108,0 -> 108.0
    s = re.sub(r"[ø⌀]", " dn ", s)
    s = re.sub(r"(^|\s)ду\.?\s*(\d{1,4})(?:\.\d+)?", r" dn \2 ", s)
    s = re.sub(r"(^|[^a-zа-я0-9])д[нп]\.?\s*=?\s*(\d{1,4})(?:\.\d+)?", r"\1 dn \2 ", s)
    s = re.sub(r"\bdn\.?\s*(\d{1,4})(?:\.\d+)?\b", r" dn \1 ", s)
    s = re.sub(r"\bd\s*=\s*(\d{1,4})(?:\.\d+)?\b", r" dn \1 ", s)
    s = re.sub(r"(\d)\s*[xх×*]\s*(\d)", r"\1x\2", s)            # 500х300 -> 500x300
    return s


def canon(text: str | None) -> str:
    """Каноничная форма для сравнения: нижний регистр, инженерные токены, без пунктуации и стоп-слов."""
    if not text:
        return ""
    s = _GOST.sub(" ", text)
    s = _canon_engineering(s)
    s = re.sub(r"[^0-9a-zа-я\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return " ".join(w for w in s.split(" ") if w and w not in STOP)


def extract_dn(text: str | None) -> int | None:
    """Вытащить условный диаметр (DN/Ду/Дн/ø) — ключевой различитель арматуры/труб."""
    if not text:
        return None
    s = _canon_engineering(_GOST.sub(" ", text))
    m = re.search(r"\bdn[\s.\-/]*(\d{1,4})", s)
    return int(m.group(1)) if m else None


def _bigrams(s: str) -> list[str]:
    s = s.replace(" ", "")
    return [s[i:i + 2] for i in range(len(s) - 1)]


def dice(a: str, b: str) -> float:
    """Коэффициент Дайса по биграммам (как string-similarity в backend)."""
    A, B = _bigrams(a), _bigrams(b)
    if not A or not B:
        return 1.0 if a == b and a != "" else 0.0
    ca, cb = Counter(A), Counter(B)
    inter = sum((ca & cb).values())
    return 2 * inter / (len(A) + len(B))


# Тип товара (различитель надёжнее, чем строка-имя у разных брендов). Слева —
# что ищем в имени, справа — каноническая метка типа (синонимы → одна метка).
TYPE_NOUNS = [
    (r"водосчет|счет[чк]", "счетчик"),
    (r"\bкран", "кран"),
    (r"задвижк|вентиль\b", "задвижка"),
    (r"фильтр", "фильтр"),
    (r"клапан", "клапан"),
    (r"редуктор", "редуктор"),
    (r"манометр", "манометр"),
    (r"термометр", "термометр"),
    (r"радиатор|конвектор", "радиатор"),
    (r"коллектор", "коллектор"),
    (r"насос", "насос"),
    (r"тройник|(?<![а-яё])отвод|муфт|переход|уголок|штуцер|ниппел", "фитинг"),
    (r"изоляц|термафлекс|энергофлекс|energoflex|утеплит", "изоляция"),
    (r"\bтруб", "труба"),
]


_WORD_RE = re.compile(r"[а-яёa-z]+", re.I)


def _type_tokens(text: str, k: int = 2) -> list[str]:
    # Ведущие значимые слова (>=4 буквы) — обычно тип товара (кран/отвод/изоляция).
    # Дубль export_html._type_tokens: импорт оттуда сюда дал бы цикл (export_html сам
    # импортирует normalize как nz), поэтому логика продублирована, а не переиспользована.
    s = (text or "").lower().replace("ё", "е")
    sig = [w for w in _WORD_RE.findall(s) if len(w) >= 4]
    return sig[:k]


def product_type(text: str) -> str | None:
    """Каноническая метка типа товара (кран/фильтр/счетчик/…) — только по ВЕДУЩИМ
    словам имени (первые 2 значимых токена), не по вхождению паттерна где угодно
    в строке. Иначе "...с имп. трубкой..." ложно даёт тип "труба"."""
    for tok in _type_tokens(text):
        for pat, label in TYPE_NOUNS:
            if re.search(pat, tok):
                return label
    return None


# Признаки запчасти/аксессуара (доп. триггер, не основной критерий — см. is_accessory).
ACCESSORY_RE = re.compile(
    r"(запасн|запчаст|ремонтн|сменн|вставк|элемент|сальник|насадк|"
    r"кронштейн|хомут|держатель|скоба|крепление|"
    r"переходник для|адаптер для|комплект для)", re.I)

_FOR_RE = re.compile(r"для\s+\S+", re.I)


def is_accessory(text: str, other_text: str | None = None) -> bool:
    """Аксессуар ОТНОСИТЕЛЬНО other_text (запроса): в тексте есть «для <слово>»
    И ведущий тип текста не совпадает с ведущим типом other_text — «Ручка для крана»
    при запросе «Кран шаровой» (ручка≠кран). Список конкретных слов — доп. триггер:
    срабатывает сам по себе, независимо от «для»/типа (кронштейн и т.п. — не бывает
    самостоятельным товаром)."""
    t = (text or "").lower().replace("ё", "е")
    if ACCESSORY_RE.search(t):
        return True
    if other_text is not None and _FOR_RE.search(t):
        return product_type(text) != product_type(other_text)
    return False


def score(query_name: str, cand_name: str,
          query_dn: int | None = None, cand_dn: int | None = None) -> float:
    """
    Межвендорная оценка «это та же позиция/тип+размер?»:
      • конфликт DN → жёсткое вето (другой типоразмер) → 0;
      • разный тип товара (фильтр ≠ клапан) → сильный штраф;
      • совпали тип И размер → уверенный кандидат (имя-схожесть как уточнение).
    У разных брендов строки имён сильно расходятся, поэтому опираемся на ТИП+DN,
    а сходство имени идёт бонусом — иначе верный по типу/размеру товар не найдётся.
    """
    qc, cc = canon(query_name), canon(cand_name)
    base = dice(qc, cc)

    # Аксессуар/запчасть в ответ на запрос самого товара — это не он.
    if is_accessory(cand_name, query_name) and not is_accessory(query_name, cand_name):
        return min(base * 0.4, 0.25)

    qdn = query_dn if query_dn is not None else extract_dn(query_name)
    cdn = cand_dn if cand_dn is not None else extract_dn(cand_name)
    if qdn is not None and cdn is not None and qdn != cdn:
        return 0.0
    dn_ok = qdn is not None and cdn is not None and qdn == cdn

    qt, ct = product_type(query_name), product_type(cand_name)
    if qt and ct and qt != ct:
        return min(base * 0.4, 0.3)              # другой тип товара — не «дешевле»
    if qt and ct and qt == ct:
        return min(1.0, 0.5 * base + (0.3 if dn_ok else 0.0) + 0.2)

    # тип не опознан с одной из сторон — опираемся на имя + согласие размера
    if dn_ok:
        base += 0.1
    return max(0.0, min(1.0, base))


if __name__ == "__main__":
    # Самопроверка на зафиксированных 9 парах (точечный фикс №2, 09.08). Первые три —
    # реальные случаи из out/comparison.json; остальные — заданные в постановке (в
    # out/comparison.json и out/external_prices.json на 09.08 нет кран/фильтр/труба-ГОСТ
    # позиций, откуда их взять дословно).
    CONFIDENT = 0.6  # держим в шаге с price-harvester/src/compare.py:23

    bad_cases = [
        ('Изоляция "Термафлекс" ФРЗ, толщиной 13мм для труб Ø25мм',
         'Автоматический регулятор перепада давления с фиксированной настройкой 1”, '
         '20 кПа, 50-960 л/ч, с имп. трубкой 1 м', 25, 25),
        ('Изоляция "Термафлекс" ФРЗ, толщиной 13мм для труб Ø32мм',
         'Кронштейн для труб стальной с резиновым уплотнением 1 1/4", 40–45 мм', 32, 32),
        ('Изоляция "Термафлекс" ФРЗ, толщиной 13мм для труб Ø40мм',
         'Кронштейн для труб стальной с резиновым уплотнением 1 1/2", 47–52 мм', 40, 40),
        ('Труба стальная Ду25 ГОСТ 3262-75',
         'Автоматический регулятор перепада давления с имп. трубкой 1 м, Ду25', 25, 25),
        ('Кран шаровой Ду25',
         'Ручка (рукоятка) для крана шарового Ду25', 25, 25),
        ('Фильтр сетчатый Ду50 фланцевый',
         'Сетка фильтрующая нержавеющая для фильтра Ду50', 50, 50),
    ]
    good_cases = [
        ('Труба стальная в ППУ изоляции Ду100',
         'Труба предизолированная ППУ 108x1.0 ПЭ Ду100', 100, 100),
        ('Теплоизоляция Energoflex 35/9',
         'Энергофлекс Супер 35/9 изоляция для труб', None, None),
        ('Труба стальная электросварная Ду25 ГОСТ 10704',
         'Труба стальная эл/сварная 25мм ГОСТ 10704-91', 25, 25),
    ]

    fails = []
    for q, c, qdn, cdn in bad_cases:
        s = score(q, c, qdn, cdn)
        ok = s < CONFIDENT
        print(f"{'PASS' if ok else 'FAIL'} [bad]  {s:.2f}  {q[:45]!r} vs {c[:45]!r}")
        if not ok:
            fails.append((q, c, s, f"< {CONFIDENT}"))

    for q, c, qdn, cdn in good_cases:
        s = score(q, c, qdn, cdn)
        ok = s >= CONFIDENT
        print(f"{'PASS' if ok else 'FAIL'} [good] {s:.2f}  {q[:45]!r} vs {c[:45]!r}")
        if not ok:
            fails.append((q, c, s, f">= {CONFIDENT}"))

    if fails:
        print(f"\n{len(fails)} of 9 FAILED (см. отчёт — это находка, не ошибка запуска):")
        for q, c, s, need in fails:
            print(f"  {s:.2f} (need {need}): {q!r} vs {c!r}")
    else:
        print("\nOK — 9/9")
