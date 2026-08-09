"""
ШАГ 1 — «список закупки» из того, что УЖЕ есть в проекте.

Из specification_items собираем уникальные позиции (наименование, артикул,
производитель, единица, кол-во, раздел). Для каждой позиции находим базу
сравнения — лучшую строку счёта (цена + поставщик) лёгким локальным скорингом.
Плюс отдаём очищенный список поставщиков из счетов (в suppliers много мусора:
банки/БИК/обрывки — их отсеиваем).

Результат: out/purchase_list.json — вход для шагов 2–6.
"""
from __future__ import annotations

import json
import os
import re

import common
import db
import normalize as nz

# Мусорные «поставщики» — это обрывки шапки счёта (банки, реквизиты, оговорки),
# которые распознавание положило в suppliers. Имя организации сначала ОБРЕЗАЕМ по
# первому реквизиту (ИНН/КПП/БИК/Сч/запятая), потом отбрасываем явный мусор.
SUPPLIER_CUT = re.compile(r"\s*(,|\bИНН\b|\bКПП\b|\bБИК\b|\bСч\.?|\bр/?с|\bк/?с)", re.I)
JUNK_SUPPLIER = re.compile(
    r"(банк|сбербанк|совкомбанк|тбанк|^ао\s*\)|^пао|^зао\s*$|акб|"
    r"исполнитель|не\s+несет|ответственност|самовывоз|доверенност|наличи[ея])",
    re.I,
)
TESTish = re.compile(r"(test|e2e|debug|образец|sample|демо|пример)", re.I)

# Порядок ВАЖЕН — проверяем сверху вниз, первое совпадение выигрывает. Вентиляцию
# ставим раньше арматуры, чтобы «клапан КПУ/противопожарный» не утёк в арматуру.
CATEGORY_RULES = [
    ("счетчики",  r"счет[чё]ик|водомер|тепловычислит"),
    ("вентиляция", r"вентилятор|решетк|диффузор|клапан\s*кпу|противопожарн|огнезадерж|воздуховод|анемостат|зонт\b"),
    ("арматура",  r"кран|задвижк|вентиль|клапан|обратн|фильтр|редуктор|манометр|термометр|балансиров"),
    ("отопление", r"радиатор|конвектор|котел|насос|коллектор|расширительн"),
    # Изоляцию проверяем ДО труб: «теплоизоляция трубная» иначе уходит в «трубы».
    ("изоляция",  r"изоляц|k-?flex|кфлекс|каучук|теплоизол|ламель|скорлуп"),
    ("трубы",     r"труб|отвод|тройник|муфт|переход|фитинг|ревизи|прочистк|пнд|пэ\d"),
    ("электрика", r"кабель|провод|щит|автомат|узо|светильник|лоток"),
]


def guess_category(name: str, section: str | None) -> str | None:
    hay = f"{name or ''} {section or ''}".lower()
    for cat, pat in CATEGORY_RULES:
        if re.search(pat, hay):
            return cat
    return None


def is_junk_name(name: str | None) -> bool:
    if not name:
        return True
    s = name.strip()
    if len(s) < 3:
        return True
    if re.fullmatch(r"[\d\s.,\-x×]+", s):   # чисто числовые/размерные «2», «500x300»
        return True
    return False


def pick_project(con) -> int:
    pid = os.environ.get("PROJECT_ID")
    if pid:
        return int(pid)
    # Берём РЕАЛЬНЫЙ проект (исключаем тестовые/отладочные/образцы), с наибольшим
    # числом позиций и счетов — на нём пилот осмысленнее.
    rows = con.execute(
        """SELECT p.id, p.name,
                  (SELECT COUNT(*) FROM specification_items si WHERE si.project_id=p.id) AS sc,
                  (SELECT COUNT(*) FROM invoices i WHERE i.project_id=p.id) AS ic
           FROM projects p
           WHERE EXISTS (SELECT 1 FROM specification_items si WHERE si.project_id=p.id
                         AND si.name IS NOT NULL AND TRIM(si.name)<>'')
           ORDER BY sc DESC, ic DESC, p.id ASC"""
    ).fetchall()
    for r in rows:
        if not TESTish.search(r["name"] or ""):
            print(f"  выбран проект #{r['id']} «{r['name']}» (позиций≈{r['sc']}, счетов={r['ic']})")
            return int(r["id"])
    if not rows:
        raise SystemExit("В БД нет позиций спецификаций.")
    return int(rows[0]["id"])  # все «тестовые» — берём первый


def load_positions(con, project_id: int) -> list[dict]:
    rows = con.execute(
        """SELECT id, name, characteristics, manufacturer, article, product_code,
                  equipment_code, unit, quantity, section
           FROM specification_items WHERE project_id=?""",
        (project_id,),
    ).fetchall()

    by_key: dict[str, dict] = {}
    for r in rows:
        if is_junk_name(r["name"]):
            continue
        article = (r["article"] or r["product_code"] or r["equipment_code"] or None)
        key = "|".join([
            nz.canon(r["name"]),
            nz.canon(r["characteristics"]),
            (r["unit"] or "").lower().strip(),
        ])
        if key in by_key:
            by_key[key]["quantity"] = (by_key[key]["quantity"] or 0) + (r["quantity"] or 0)
            by_key[key]["spec_item_ids"].append(r["id"])
            continue
        by_key[key] = {
            "spec_item_id": r["id"],
            "spec_item_ids": [r["id"]],
            "name": r["name"].strip(),
            "characteristics": (r["characteristics"] or "").strip() or None,
            "manufacturer": (r["manufacturer"] or "").strip() or None,
            "article": (article or "").strip() or None,
            "unit": (r["unit"] or "").strip() or None,
            "quantity": r["quantity"],
            "section": (r["section"] or "").strip() or None,
            "dn": nz.extract_dn(f"{r['name']} {r['characteristics'] or ''}"),
            "category_guess": guess_category(r["name"], r["section"]),
        }
    return list(by_key.values())


def load_invoice_baseline(con, project_id: int) -> list[dict]:
    rows = con.execute(
        """SELECT ii.name, ii.article, ii.unit, ii.price, s.name AS supplier
           FROM invoice_items ii
           JOIN invoices i ON ii.invoice_id=i.id
           LEFT JOIN suppliers s ON i.supplier_id=s.id
           WHERE i.project_id=? AND ii.price>0 AND COALESCE(ii.is_delivery,0)=0""",
        (project_id,),
    ).fetchall()
    items = []
    for r in rows:
        items.append({
            "name": r["name"], "article": r["article"], "unit": r["unit"],
            "price": r["price"], "supplier": r["supplier"],
            "canon": nz.canon(r["name"]), "dn": nz.extract_dn(r["name"]),
        })
    return items


def attach_baseline(positions: list[dict], inv: list[dict], threshold: float = 0.58) -> None:
    for p in positions:
        best, best_s = None, 0.0
        for it in inv:
            s = nz.score(p["name"], it["name"], p["dn"], it["dn"])
            if s > best_s:
                best_s, best = s, it
        if best and best_s >= threshold:
            p["invoice_baseline"] = {
                "price": best["price"], "supplier": best["supplier"],
                "name": best["name"], "unit": best["unit"],
                "match_score": round(best_s, 3),
            }
        else:
            p["invoice_baseline"] = None


def clean_suppliers(con, project_id: int) -> list[str]:
    rows = con.execute(
        """SELECT DISTINCT s.name FROM suppliers s
           JOIN invoices i ON i.supplier_id=s.id
           WHERE i.project_id=? AND s.name IS NOT NULL""",
        (project_id,),
    ).fetchall()
    out = []
    for r in rows:
        nm = (r["name"] or "").strip()
        nm = SUPPLIER_CUT.split(nm, maxsplit=1)[0].strip().strip('"').strip()
        if len(nm) < 4 or JUNK_SUPPLIER.search(nm):
            continue
        out.append(nm)
    return sorted(set(out))


def build(project_id: int | None = None) -> dict:
    con = db.connect(readonly=True)
    try:
        pid = project_id or pick_project(con)
        positions = load_positions(con, pid)
        inv = load_invoice_baseline(con, pid)
        attach_baseline(positions, inv)
        suppliers = clean_suppliers(con, pid)
    finally:
        con.close()

    result = {
        "project_id": pid,
        "generated_at": common.now_iso(),
        "snapshot_date": common.today(),
        "positions_total": len(positions),
        "suppliers_seen": suppliers,
        "positions": positions,
    }
    out_file = common.OUT / "purchase_list.json"
    out_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    with_base = sum(1 for p in positions if p.get("invoice_baseline"))
    print(f"ШАГ 1 — список закупки (project_id={pid}):")
    print(f"  уникальных позиций: {len(positions)}")
    print(f"  с базой из счёта (цена+поставщик): {with_base}/{len(positions)}")
    print(f"  поставщиков из счетов (после чистки): {len(suppliers)}")
    print(f"  → {out_file}")
    return result


if __name__ == "__main__":
    build()
