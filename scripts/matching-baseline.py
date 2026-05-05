"""
Print and persist baseline matching metrics for all projects.

Run from the repository root:
    python scripts/matching-baseline.py
"""

from __future__ import annotations

import datetime as dt
import io
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any


sys.dont_write_bytecode = True

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DB_PATH = PROJECT_ROOT / "database" / "budget_automation.db"
OUTPUT_PATH = PROJECT_ROOT / "scripts" / "benchmark-ready" / "matching-baseline.json"


def configure_stdout() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    elif sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def percent(part: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round(part / total * 100, 1)


def count_map(rows: list[sqlite3.Row], key: str, value: str) -> dict[int, int]:
    return {int(row[key]): int(row[value] or 0) for row in rows}


def fetch_match_type_distribution(conn: sqlite3.Connection) -> tuple[dict[int, dict[str, int]], dict[str, int]]:
    rows = conn.execute(
        """
        SELECT
          si.project_id,
          COALESCE(NULLIF(TRIM(mi.match_type), ''), 'unknown') AS match_type,
          COUNT(*) AS count
        FROM matched_items mi
        JOIN specification_items si ON si.id = mi.specification_item_id
        GROUP BY si.project_id, COALESCE(NULLIF(TRIM(mi.match_type), ''), 'unknown')
        ORDER BY match_type
        """
    ).fetchall()

    per_project: dict[int, dict[str, int]] = {}
    total: dict[str, int] = {}
    for row in rows:
        project_id = int(row["project_id"])
        match_type = str(row["match_type"])
        count = int(row["count"] or 0)
        per_project.setdefault(project_id, {})[match_type] = count
        total[match_type] = total.get(match_type, 0) + count

    return per_project, total


def collect_metrics(conn: sqlite3.Connection, baseline_date: str) -> dict[str, Any]:
    projects = conn.execute(
        """
        SELECT id, name
        FROM projects
        ORDER BY name COLLATE NOCASE, id
        """
    ).fetchall()

    spec_counts = count_map(
        conn.execute(
            """
            SELECT project_id, COUNT(*) AS count
            FROM specification_items
            GROUP BY project_id
            """
        ).fetchall(),
        "project_id",
        "count",
    )

    invoice_counts = count_map(
        conn.execute(
            """
            SELECT i.project_id, COUNT(ii.id) AS count
            FROM invoices i
            JOIN invoice_items ii ON ii.invoice_id = i.id
            GROUP BY i.project_id
            """
        ).fetchall(),
        "project_id",
        "count",
    )

    match_stats = {
        int(row["project_id"]): {
            "total_matches": int(row["total_matches"] or 0),
            "confirmed_matches": int(row["confirmed_matches"] or 0),
            "auto_matches": int(row["auto_matches"] or 0),
        }
        for row in conn.execute(
            """
            SELECT
              si.project_id,
              COUNT(mi.id) AS total_matches,
              SUM(CASE WHEN COALESCE(mi.is_confirmed, 0) = 1 THEN 1 ELSE 0 END) AS confirmed_matches,
              SUM(CASE WHEN mi.match_type IS NOT NULL AND mi.match_type != 'manual' THEN 1 ELSE 0 END) AS auto_matches
            FROM matched_items mi
            JOIN specification_items si ON si.id = mi.specification_item_id
            GROUP BY si.project_id
            """
        ).fetchall()
    }

    match_type_by_project, match_type_distribution = fetch_match_type_distribution(conn)

    per_project: list[dict[str, Any]] = []
    for project in projects:
        project_id = int(project["id"])
        spec_items = spec_counts.get(project_id, 0)
        invoice_items = invoice_counts.get(project_id, 0)
        stats = match_stats.get(
            project_id,
            {
                "total_matches": 0,
                "confirmed_matches": 0,
                "auto_matches": 0,
            },
        )

        per_project.append(
            {
                "project_id": project_id,
                "project_name": project["name"],
                "spec_items": spec_items,
                "invoice_items": invoice_items,
                "total_matches": stats["total_matches"],
                "confirmed_matches": stats["confirmed_matches"],
                "auto_matches": stats["auto_matches"],
                "match_rate": percent(stats["confirmed_matches"], spec_items),
                "auto_rate": percent(stats["auto_matches"], stats["total_matches"]),
                "match_type_distribution": match_type_by_project.get(project_id, {}),
            }
        )

    total_spec_items = sum(project["spec_items"] for project in per_project)
    total_invoice_items = sum(project["invoice_items"] for project in per_project)
    total_matches = sum(project["total_matches"] for project in per_project)
    confirmed_matches = sum(project["confirmed_matches"] for project in per_project)
    auto_matches = sum(project["auto_matches"] for project in per_project)

    return {
        "date": baseline_date,
        "summary": {
            "total_projects": len(per_project),
            "projects_with_specs": sum(1 for project in per_project if project["spec_items"] > 0),
            "total_spec_items": total_spec_items,
            "total_invoice_items": total_invoice_items,
            "total_matches": total_matches,
            "confirmed_matches": confirmed_matches,
            "auto_matches": auto_matches,
            "overall_match_rate": percent(confirmed_matches, total_spec_items),
            "overall_auto_rate": percent(auto_matches, total_matches),
        },
        "match_type_distribution": match_type_distribution,
        "per_project": per_project,
    }


def format_table(metrics: dict[str, Any]) -> str:
    headers = ["Project", "Specs", "Inv.Items", "Matches", "Confirmed", "Auto", "Match%", "Auto%"]
    rows: list[list[str]] = []

    for project in metrics["per_project"]:
        rows.append(
            [
                project["project_name"],
                str(project["spec_items"]),
                str(project["invoice_items"]),
                str(project["total_matches"]),
                str(project["confirmed_matches"]),
                str(project["auto_matches"]),
                f"{project['match_rate']:.1f}%",
                f"{project['auto_rate']:.1f}%",
            ]
        )

    summary = metrics["summary"]
    total_row = [
        "TOTAL",
        str(summary["total_spec_items"]),
        str(summary["total_invoice_items"]),
        str(summary["total_matches"]),
        str(summary["confirmed_matches"]),
        str(summary["auto_matches"]),
        f"{summary['overall_match_rate']:.1f}%",
        f"{summary['overall_auto_rate']:.1f}%",
    ]

    all_rows = rows + [total_row]
    widths = [len(header) for header in headers]
    widths[0] = max(widths[0], 27)
    for row in all_rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    def render_row(row: list[str]) -> str:
        cells = [row[0].ljust(widths[0])]
        cells.extend(row[index].rjust(widths[index]) for index in range(1, len(row)))
        return " | ".join(cells)

    separator = "-|-".join("-" * width for width in widths)
    lines = [
        "=== Matching Baseline ===",
        f"Date: {metrics['date']}",
        render_row(headers),
        separator,
    ]
    lines.extend(render_row(row) for row in rows)
    lines.append(separator)
    lines.append(render_row(total_row))
    lines.append("Match type distribution:")

    distribution = metrics["match_type_distribution"]
    if distribution:
        type_width = max(len(match_type) for match_type in distribution)
        count_width = max(len(str(count)) for count in distribution.values())
        for match_type in sorted(distribution):
            lines.append(f"  {match_type.ljust(type_width)}: {str(distribution[match_type]).rjust(count_width)}")
    else:
        lines.append("  none: 0")

    return "\n".join(lines)


def write_json(metrics: dict[str, Any]) -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as output_file:
        json.dump(metrics, output_file, ensure_ascii=False, indent=2)
        output_file.write("\n")


def main() -> int:
    configure_stdout()

    if not DB_PATH.exists():
        print(f"Database not found: {DB_PATH}", file=sys.stderr)
        return 1

    baseline_date = dt.date.today().isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        metrics = collect_metrics(conn, baseline_date)

    print(format_table(metrics))
    write_json(metrics)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
