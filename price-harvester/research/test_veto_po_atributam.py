# -*- coding: utf-8 -*-
"""Проверка приёма из разведки: hard veto по критичным атрибутам.

Правило: если атрибут извлечён И у позиции спецификации, И у карточки товара,
и значения РАЗОШЛИСЬ — отказ. Не «похоже», не «примерно» — отказ.
Плюс нормализация Ду/DN/дюйм в один ключ (ISO 6708) и sparsity-порог.

Прогон на всех 30 найденных позициях последнего замера, включая 3 известные ошибки.
"""
import csv, io, re

ROOT = r"C:\Users\home\vscode101\budget-automation"

# --- словарь номиналов: ISO 6708, наружный диаметр фиксирован для DN ---
DN_TO_INCH = {15: '1/2', 20: '3/4', 25: '1', 32: '1_1/4', 40: '1_1/2', 50: '2',
              65: '2_1/2', 80: '3', 100: '4', 125: '5', 150: '6', 200: '8'}
INCH_TO_DN = {v: k for k, v in DN_TO_INCH.items()}


def canon_dn(text):
    """Все написания одного номинала → один ключ."""
    out = set()
    for m in re.finditer(r"(?:ду|dn|ду\s*)\s*(\d{2,3})", text, re.I):
        out.add(int(m.group(1)))
    for m in re.finditer(r"(\d)\s*[\"”]|(\d)\s*/\s*(\d)\s*[\"”]", text):
        pass
    for token, dn in INCH_TO_DN.items():
        if re.search(re.escape(token.replace('_', ' ')) + r'\s*[\"”]', text):
            out.add(dn)
    return out


ATTRS = {
    "длина":     r"\bL\s*=\s*(\d+(?:[.,]\d+)?)",
    "диаметр_ф": r"[ØOØ⌀]\s*(\d{2,3})",
    "sdr":       r"\bSDR\s*(\d{1,2})",
    "ip":        r"\bIP\s*(\d{2})",
    "класс_т":   r"кл\.?\s*точн\.?\s*(\d(?:[.,]\d)?)",
    "давление":  r"\b(?:Ру|PN|Py)\s*(\d{1,3})",
    "темп_макс": r"\bTmax\s*(\d{2,3})",
    "толщина_s": r"\bS\s*=\s*(\d+(?:[.,]\d+)?)",
}


def attrs(text):
    got = {}
    for name, rx in ATTRS.items():
        m = re.search(rx, text, re.I)
        if m:
            got[name] = m.group(1).replace(",", ".")
    dn = canon_dn(text)
    if dn:
        got["номинал_DN"] = ",".join(str(x) for x in sorted(dn))
    return got


def veto(spec_name, card_name):
    """Возвращает (решение, объяснение)."""
    a, b = attrs(spec_name), attrs(card_name)
    common = set(a) & set(b)
    conflicts = [(k, a[k], b[k]) for k in common if a[k] != b[k]]
    if conflicts:
        k, x, y = conflicts[0]
        return "ОТКАЗ", "%s: в спецификации %s, на карточке %s" % (k, x, y)
    # sparsity-порог: мало общих атрибутов + нет кода = не подтверждено
    if len(common) == 0:
        return "НЕ ПОДТВЕРЖДЕНО", "общих проверяемых атрибутов нет (%d у позиции, %d у карточки)" % (len(a), len(b))
    return "ПРИНЯТЬ", "совпали: %s" % ", ".join("%s=%s" % (k, a[k]) for k in sorted(common))


rows = [r for r in csv.DictReader(io.open(ROOT + r"\price-harvester\out\zamer_spec2_result.csv", encoding="utf-8-sig"))
        if r["status"] == "found"]

# известные ошибки прошлого прогона — проверяем, ловит ли их veto
KNOWN_BAD = ["Термометр биметаллический", "Преобразователь давления", "Металл сортовой", "Теплоизоляция труб"]

print("%-46s %-17s %s" % ("ПОЗИЦИЯ", "РЕШЕНИЕ", "ПОЧЕМУ"))
print("-" * 130)
caught = accepted = unconfirmed = 0
for r in rows:
    has_code = bool(r["code"])
    # позиции с подтверждённым кодом veto не трогает — там код уже доказал совпадение
    if has_code:
        decision, why = "ПРИНЯТЬ (код)", "код %s подтверждён на странице" % r["code"][:22]
    else:
        decision, why = veto(r["name"], r["card"])
    bad = any(k.lower() in r["name"].lower() for k in KNOWN_BAD)
    mark = " <-- известная ошибка" if bad else ""
    if decision.startswith("ПРИНЯТЬ"):
        accepted += 1
    elif decision == "ОТКАЗ":
        caught += 1
    else:
        unconfirmed += 1
    print("%-46s %-17s %s%s" % (r["name"][:45], decision, why[:62], mark))

print("\n" + "=" * 70)
print("принято: %d | отказ по конфликту атрибутов: %d | не подтверждено: %d" % (accepted, caught, unconfirmed))
print("\nПРОВЕРКА НА ИЗВЕСТНЫХ ОШИБКАХ:")
for r in rows:
    if any(k.lower() in r["name"].lower() for k in KNOWN_BAD) and not r["code"]:
        d, w = veto(r["name"], r["card"])
        print("  %-42s → %-17s %s" % (r["name"][:41], d, w[:60]))
