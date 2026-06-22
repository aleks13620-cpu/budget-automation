"""
Оркестратор price-harvester. Прогоняет шаги 1→6 одной командой.

Примеры:
  python src/run.py --limit 5                 # пилот: 5 позиций (реальный проект авто)
  python src/run.py --project-id 12 --limit 5
  python src/run.py --category арматура --limit 8
  python src/run.py --steps build,resolve     # только часть шагов

Фаза 1 (текущая): результат — отдельный отчёт (out/comparison.*, out/qa_report.md).
В price_list_items НИЧЕГО не пишем — критический путь матчинга не трогаем.
"""
from __future__ import annotations

import argparse
import os

import common  # noqa: F401  (грузит .env/пути первым)


def main() -> None:
    ap = argparse.ArgumentParser(description="price-harvester — сбор внешних цен поставщиков")
    ap.add_argument("--project-id", type=int, default=None)
    ap.add_argument("--limit", type=int, default=None, help="сколько позиций в пилоте (по умолч. PILOT_LIMIT=5)")
    ap.add_argument("--category", type=str, default=None, help="арматура | счетчики | вентиляция | …")
    ap.add_argument("--steps", type=str, default="build,resolve,collect,load,qa,compare",
                    help="какие шаги запускать через запятую")
    args = ap.parse_args()

    if args.project_id is not None:
        os.environ["PROJECT_ID"] = str(args.project_id)
    if args.limit is not None:
        os.environ["PILOT_LIMIT"] = str(args.limit)
    if args.category:
        os.environ["PILOT_CATEGORY"] = args.category

    steps = [s.strip() for s in args.steps.split(",") if s.strip()]

    if "build" in steps:
        import build_purchase_list
        build_purchase_list.build(args.project_id)
        print()
    if "resolve" in steps:
        import resolve_sources
        resolve_sources.resolve(args.limit, args.category)
        print()
    if "collect" in steps:
        import collect_prices
        collect_prices.collect()
        print()
    if "load" in steps:
        import load_db
        load_db.load()
        print()
    if "qa" in steps:
        import qa_report
        qa_report.report()
        print()
    if "compare" in steps:
        import compare
        compare.compare()


if __name__ == "__main__":
    main()
