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
    (r"\bтруб", "труба"),
]


def product_type(text: str) -> str | None:
    """Каноническая метка типа товара по имени (кран/фильтр/счетчик/…), или None."""
    c = canon(text)
    for pat, label in TYPE_NOUNS:
        if re.search(pat, c):
            return label
    return None


# Признаки запчасти/аксессуара («…для счетчика», «фильтроэлемент», «сальниковый узел»):
# это НЕ сам товар, и их дешевизна занижает диапазон. Если кандидат — аксессуар,
# а запрос — нет, такой кандидат отбраковываем.
ACCESSORY_RE = re.compile(
    r"(\bдля |запасн|запчаст|ремонтн|сменн|вставк|элемент|сальник|насадк|"
    r"переходник для|адаптер для|комплект для)", re.I)


def is_accessory(text: str) -> bool:
    return bool(ACCESSORY_RE.search((text or "").lower().replace("ё", "е")))


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
    if is_accessory(cand_name) and not is_accessory(query_name):
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
