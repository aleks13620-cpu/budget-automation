# -*- coding: utf-8 -*-
"""Разделение спецификации на предметы поиска — версия 2.

Ключевая правка: марка изделия ищется ПО ПРИЗНАКУ во всех полях позиции,
а не в конкретном поле. Парсеры кладут её куда придётся: в product_code,
в characteristics, в manufacturer, прямо в name.
"""
import re, sqlite3
from collections import Counter

DB = r"C:\Users\home\vscode101\budget-automation\database\budget_automation.db"

# марка = токен с буквами И цифрами, длиной от 4, допускает дефис/точку/косую
MARK = re.compile(r"(?<![А-Яа-яA-Za-z])"
                  r"(?=[^\s]*[A-ZА-Я])(?=[^\s]*\d)"
                  r"[A-ZА-Я][A-ZА-Яa-zа-я0-9]*(?:[-./][A-ZА-Я0-9][A-ZА-Яa-z0-9]*)*"
                  r"(?:\s?\d{1,4}(?:[-х×x/]\d{1,4})*)?")
# НЕ марка: ссылки на стандарты и ТИПОРАЗМЕРЫ. Слитное DN20/Ду25/Ру16 — тоже типоразмер,
# по нему поиск уходит на любой товар того же диаметра (проверено: «прямой DN20» → клапан Herz).
NOT_MARK = re.compile(
    r"^(ГОСТ|ТУ|СНиП|СП|EI|IP|RAL|L|S|Ø|№)\b"
    r"|^[TТ]max|^[QQ]max|^Kvs|^[PР][yуY]\d|^[PР]N\d"
    r"|^(DN|DY|ДУ|DУ|PN|РУ|PУ|D|Ф)\s*\d+"          # Dу65/Py16, Ду25/Р, DN20 — размер, не марка
    r"|^\d+$", re.I)

MADE = re.compile(r"ГОСТ\s*14918|из\s+оцинк\w*\.?\s+стали\s+толщиной|толщиной\s+S\s*=|"
                  r"^(воздуховод|отвод|переход |врезка|заглушка|зонт |кожух)", re.I)
PROJECT = re.compile(r"КЛАД|ПРОК|КПУ|ВРАН|клапан противопожарн|дымоудал|установка приточ|"
                     r"узел этажный|блок ввода|смесительный узел|в составе:|шумоглушител", re.I)



# типоразмерный хвост: BVS-R/Dy25/Py63/Tmax180 -> BVS-R, «O80мм 0» -> пусто
SIZE_SEG = re.compile(r"^(DN|DY|ДУ|PN|РУ|D|Ф|O|Ø|L|S|G|Kvs|Tmax|Тmax|Qmax)\s*[\d./]+", re.I)


def trim_size_tail(tok):
    parts = re.split(r"[/]", tok)
    keep = []
    for i, seg in enumerate(parts):
        seg = seg.strip()
        if i > 0 and (SIZE_SEG.match(seg) or re.fullmatch(r"[\d.,x×х-]+\s*(мм|м|кг)?", seg, re.I)):
            break
        keep.append(seg)
    tok = "/".join(keep).strip()
    # хвост вида «O80мм 0» или «Ду25 Р» — размер, а не марка
    tok = re.sub(r"\s+\d+([.,]\d+)?$", "", tok).strip()
    if re.match(r"^[OØ]\s*\d", tok, re.I) or re.search(r"\d\s*мм$", tok, re.I):
        return ""
    return tok


# марка вида «SonoSelect 10», «АМР 150х150» — слово и число раздельно
MARK_WORDNUM = re.compile(
    r"(?<![А-Яа-яA-Za-z])"
    r"([A-Z][A-Za-z]{2,}|[А-Я]{2,})"          # SonoSelect / АМР / ШГ
    r"[\s-]?(\d{1,4}(?:[-х×x/.]\d{1,4})*)")   # 10 / 150х150 / 50-30-1000
WORDNUM_STOP = {"ду", "дн", "ру", "pn", "dn", "dy", "ру", "py", "тип", "класс", "кран",
                "клапан", "труба", "отвод", "фильтр", "насос", "узел", "блок", "шт", "мм",
                "гост", "tmax", "qmax", "kvs", "тmax", "ip", "ral", "ei", "din", "ph"}


def find_mark(*fields):
    """Марка из любого поля. Возвращает (марка, из какого поля)."""
    names = ("name", "product_code", "characteristics", "manufacturer", "marking", "article", "full_name")
    for fname, val in zip(names, fields):
        if not val:
            continue
        s = str(val).strip()
        for m in MARK_WORDNUM.finditer(s):
            word, num = m.group(1), m.group(2)
            if word.lower() in WORDNUM_STOP or len(word) < 3:
                continue
            tok = "%s %s" % (word, num)
            if NOT_MARK.match(tok):
                continue
            return tok, fname
        for m in MARK.finditer(s):
            tok = m.group(0).strip()
            tok = trim_size_tail(tok)
            if len(tok) < 4 or NOT_MARK.match(tok):
                continue
            if not re.search(r"\d", tok) or not re.search(r"[A-ZА-Я]", tok):
                continue
            return tok, fname
    return None, None


def classify(row, full_name):
    mark, src = find_mark(row["name"], row["product_code"], row["characteristics"],
                          row["manufacturer"], row["marking"], row["article"], row["full_name"])
    text = full_name + " " + (row["characteristics"] or "")
    if MADE.search(text):
        return "A. изготавливается", mark, src
    if PROJECT.search(text):
        return "B. проектное", mark, src
    if mark:
        return "C. марка изделия", mark, src
    return "D. без марки", None, None


# Поля, из которых складывается ПОИСКОВЫЙ ЗАПРОС: марка ищется по ним (find_mark),
# производитель и полное имя идут в строку запроса. Ключ дедупа обязан совпадать
# с ними, иначе позиции с РАЗНЫМИ запросами схлопнутся в одну и часть товаров
# просто не попадёт в поиск цен.
KEY_FIELDS = ("name", "product_code", "characteristics", "manufacturer", "marking", "article")


def dedup_key(row, full_name):
    """Ключ «это одна и та же позиция спецификации», ЕДИНСТВЕННОЕ определение на python.
    Копия правила на TS — backend/src/services/specClassifier.ts; расхождение ловит сверка.

    Раньше ключом был срез полного имени в 60 символов + артикул + производитель.
    Он склеивал разные товары: full() берёт `full_name or name`, поэтому у строк, где
    заполнено full_name, СОБСТВЕННОЕ имя (а это и есть артикул — C21-500-400, C21-500-500…)
    в ключ не попадало вовсе, и пять разных радиаторов считались одной позицией.
    Замер 27.08.2026 по всей базе: возвращает в поиск +65 позиций на вентиляционной
    спецификации из 704 строк и +1 на 19_8-24-ОВ.xlsx, лишних запросов не добавляет.
    """
    # «ложное -> пусто», как было у прежнего ключа (`r["product_code"] or ""`):
    # число 0 и None дают одно и то же по обе стороны, python и JS тут совпадают.
    return (full_name,) + tuple("" if not row[f] else str(row[f]).strip() for f in KEY_FIELDS)


def run():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    specs = c.execute("""select s.id, s.file_name, count(si.id) n from specifications s
        join specification_items si on si.specification_id=s.id
        group by s.id having n > 20 order by n desc""").fetchall()
    seen_f, targets = set(), []
    for s in specs:
        if s["file_name"] in seen_f:
            continue
        seen_f.add(s["file_name"]); targets.append(s)

    print("%-42s%6s%9s%8s%9s%9s" % ("спецификация", "поз", "C марка", "D без", "A изгот", "B проект"))
    print("-" * 84)
    agg, src_stat = Counter(), Counter()
    for s in targets[:6]:
        rows = c.execute("select * from specification_items where specification_id=?", (s["id"],)).fetchall()
        by_id = {r["id"]: r for r in rows}

        def full(r):
            parts, cur, g = [], r, 0
            while cur is not None and g < 5:
                nm = (cur["full_name"] or cur["name"] or "").strip()
                if nm and nm not in parts:
                    parts.insert(0, nm)
                cur = by_id.get(cur["parent_item_id"]); g += 1
            return re.sub(r"\s+", " ", " ".join(parts))[:120]

        b, seen = Counter(), set()
        for r in rows:
            if not r["quantity"]:
                continue
            fn = full(r)
            key = dedup_key(r, fn)
            if key in seen:
                continue
            seen.add(key)
            k, mark, src = classify(r, fn)
            b[k[0]] += 1; agg[k[0]] += 1
            if src:
                src_stat[src] += 1
        t = sum(b.values()) or 1
        print("%-42s%6d%6d%3.0f%%%5d%3.0f%%%6d%3.0f%%%6d%3.0f%%" % (
            str(s["file_name"])[:41], t, b["C"], b["C"]/t*100, b["D"], b["D"]/t*100,
            b["A"], b["A"]/t*100, b["B"], b["B"]/t*100))
    T = sum(agg.values())
    print("-" * 84)
    print("%-42s%6d%6d%3.0f%%%5d%3.0f%%%6d%3.0f%%%6d%3.0f%%" % (
        "ИТОГО", T, agg["C"], agg["C"]/T*100, agg["D"], agg["D"]/T*100,
        agg["A"], agg["A"]/T*100, agg["B"], agg["B"]/T*100))
    print("\nоткуда бралась марка:", ", ".join("%s×%d" % (k, v) for k, v in src_stat.most_common()))

    print("\n=== выборочная проверка: что признано маркой ===")
    for sid in (35, 4, 34):
        rows = c.execute("select * from specification_items where specification_id=? and quantity is not null limit 60", (sid,)).fetchall()
        shown = 0
        for r in rows:
            mark, src = find_mark(r["name"], r["product_code"], r["characteristics"],
                                  r["manufacturer"], r["marking"], r["article"], r["full_name"])
            if mark and shown < 4:
                print("   спец#%-3d %-46s → марка %-22s (из %s)" % (sid, str(r["name"])[:45], mark[:21], src))
                shown += 1


run()
