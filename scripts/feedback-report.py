"""
Print operator feedback error statistics by supplier.

Run from the repository root:
    python scripts/feedback-report.py
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import sqlite3
import sys
from pathlib import Path
from typing import Any


sys.dont_write_bytecode = True

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = PROJECT_ROOT / "database" / "budget_automation.db"
TOP_SUPPLIERS_LIMIT = 10


def configure_stdout() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    elif sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def parse_date(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected date in YYYY-MM-DD format") from exc


def default_since() -> dt.date:
    return dt.date.today() - dt.timedelta(days=30)


def table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        """,
        (table_name,),
    ).fetchone()
    return row is not None


def table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    if not table_exists(conn, table_name):
        return set()
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {str(row["name"]) for row in rows}


def markdown_cell(value: Any) -> str:
    text = str(value if value is not None else "").strip()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\n", "<br>")
    text = text.replace("|", "\\|")
    return text or "-"


def status_label(status: str) -> str:
    labels = {
        "all": "all",
        "new": "new",
        "resolved": "resolved",
    }
    return labels[status]


def supplier_join(conn: sqlite3.Connection) -> tuple[str, str]:
    feedback_columns = table_columns(conn, "operator_feedback")
    invoice_item_columns = table_columns(conn, "invoice_items")
    invoice_columns = table_columns(conn, "invoices")
    price_list_item_columns = table_columns(conn, "price_list_items")
    price_list_columns = table_columns(conn, "price_lists")
    has_suppliers = table_exists(conn, "suppliers")

    if not has_suppliers:
        return "'Без поставщика'", ""

    can_join_invoice_supplier = (
        "invoice_item_id" in feedback_columns
        and "id" in invoice_item_columns
        and "invoice_id" in invoice_item_columns
        and "id" in invoice_columns
        and "supplier_id" in invoice_columns
    )
    can_join_price_list_supplier = (
        "price_list_item_id" in feedback_columns
        and "source" in feedback_columns
        and "id" in price_list_item_columns
        and "price_list_id" in price_list_item_columns
        and "id" in price_list_columns
        and "supplier_id" in price_list_columns
    )

    if "supplier_id" in feedback_columns and can_join_invoice_supplier and can_join_price_list_supplier:
        return (
            "COALESCE(NULLIF(TRIM(s.name), ''), 'Р‘РµР· РїРѕСЃС‚Р°РІС‰РёРєР°')",
            """
            LEFT JOIN invoice_items ii ON COALESCE(f.source, 'invoice') = 'invoice' AND ii.id = f.invoice_item_id
            LEFT JOIN invoices i ON i.id = ii.invoice_id
            LEFT JOIN price_list_items pli ON f.source = 'price_list' AND pli.id = f.price_list_item_id
            LEFT JOIN price_lists pl ON pl.id = pli.price_list_id
            LEFT JOIN suppliers s ON s.id = COALESCE(f.supplier_id, i.supplier_id, pl.supplier_id)
            """,
        )

    if "supplier_id" in feedback_columns and can_join_invoice_supplier:
        return (
            "COALESCE(NULLIF(TRIM(s.name), ''), 'Без поставщика')",
            """
            LEFT JOIN invoice_items ii ON ii.id = f.invoice_item_id
            LEFT JOIN invoices i ON i.id = ii.invoice_id
            LEFT JOIN suppliers s ON s.id = COALESCE(f.supplier_id, i.supplier_id)
            """,
        )

    if "supplier_id" in feedback_columns:
        return (
            "COALESCE(NULLIF(TRIM(s.name), ''), 'Без поставщика')",
            "LEFT JOIN suppliers s ON s.id = f.supplier_id",
        )

    if can_join_invoice_supplier:
        return (
            "COALESCE(NULLIF(TRIM(s.name), ''), 'Без поставщика')",
            """
            LEFT JOIN invoice_items ii ON ii.id = f.invoice_item_id
            LEFT JOIN invoices i ON i.id = ii.invoice_id
            LEFT JOIN suppliers s ON s.id = i.supplier_id
            """,
        )

    return "'Без поставщика'", ""


def fetch_breakdown(
    conn: sqlite3.Connection,
    since: dt.date,
    status: str,
) -> list[sqlite3.Row]:
    if not table_exists(conn, "operator_feedback"):
        raise RuntimeError("table operator_feedback does not exist")

    feedback_columns = table_columns(conn, "operator_feedback")
    required_columns = {"type", "created_at"}
    missing_columns = sorted(required_columns - feedback_columns)
    if missing_columns:
        raise RuntimeError(
            "table operator_feedback is missing required columns: "
            + ", ".join(missing_columns)
        )

    feedback_status_expr = (
        "COALESCE(NULLIF(TRIM(f.status), ''), 'new')"
        if "status" in feedback_columns
        else "'new'"
    )
    supplier_expr, joins = supplier_join(conn)

    query = f"""
        WITH feedback AS (
          SELECT
            {supplier_expr} AS supplier,
            COALESCE(NULLIF(TRIM(f.type), ''), 'unknown') AS error_type,
            {feedback_status_expr} AS feedback_status,
            f.created_at AS created_at
          FROM operator_feedback f
          {joins}
          WHERE date(f.created_at) >= date(:since)
        )
        SELECT
          supplier,
          error_type,
          COUNT(*) AS error_count,
          SUM(CASE WHEN feedback_status = 'new' THEN 1 ELSE 0 END) AS new_count,
          SUM(CASE WHEN feedback_status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count
        FROM feedback
        WHERE (:status = 'all' OR feedback_status = :status)
        GROUP BY supplier, error_type
        ORDER BY error_count DESC, supplier COLLATE NOCASE, error_type COLLATE NOCASE
    """

    return conn.execute(
        query,
        {
            "since": since.isoformat(),
            "status": status,
        },
    ).fetchall()


def supplier_totals(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    totals: dict[str, dict[str, Any]] = {}
    for row in rows:
        supplier = str(row["supplier"])
        supplier_total = totals.setdefault(
            supplier,
            {
                "supplier": supplier,
                "error_count": 0,
                "new_count": 0,
                "resolved_count": 0,
            },
        )
        supplier_total["error_count"] += int(row["error_count"] or 0)
        supplier_total["new_count"] += int(row["new_count"] or 0)
        supplier_total["resolved_count"] += int(row["resolved_count"] or 0)

    return sorted(
        totals.values(),
        key=lambda row: (-int(row["error_count"]), str(row["supplier"]).casefold()),
    )


def print_breakdown(rows: list[sqlite3.Row]) -> None:
    print("## Ошибки по поставщикам и типам")
    print()
    print("| Поставщик | Тип ошибки | Всего | Новые | Решённые |")
    print("|---|---|---:|---:|---:|")
    for row in rows:
        print(
            "| "
            + " | ".join(
                [
                    markdown_cell(row["supplier"]),
                    markdown_cell(row["error_type"]),
                    str(int(row["error_count"] or 0)),
                    str(int(row["new_count"] or 0)),
                    str(int(row["resolved_count"] or 0)),
                ]
            )
            + " |"
        )


def print_top_suppliers(rows: list[dict[str, Any]]) -> None:
    print()
    print("## Топ поставщиков по количеству ошибок")
    print()
    print("| # | Поставщик | Всего | Новые | Решённые |")
    print("|---:|---|---:|---:|---:|")
    for index, row in enumerate(rows[:TOP_SUPPLIERS_LIMIT], start=1):
        print(
            "| "
            + " | ".join(
                [
                    str(index),
                    markdown_cell(row["supplier"]),
                    str(int(row["error_count"] or 0)),
                    str(int(row["new_count"] or 0)),
                    str(int(row["resolved_count"] or 0)),
                ]
            )
            + " |"
        )


def print_report(rows: list[sqlite3.Row], since: dt.date, status: str) -> None:
    if not rows:
        print(f"Нет ошибок с {since.isoformat()} (status: {status_label(status)}).")
        return

    print("# Отчёт по ошибкам операторов")
    print()
    print(f"- Период: с {since.isoformat()}")
    print(f"- Статус: {status_label(status)}")
    print()
    print_breakdown(rows)
    print_top_suppliers(supplier_totals(rows))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Print a Markdown feedback report grouped by supplier and error type.",
    )
    parser.add_argument(
        "--since",
        type=parse_date,
        default=default_since(),
        metavar="YYYY-MM-DD",
        help="start date for the report, inclusive (default: last 30 days)",
    )
    parser.add_argument(
        "--status",
        choices=("new", "resolved", "all"),
        default="all",
        help="feedback status to include (default: all)",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB_PATH,
        help="path to SQLite database (default: database/budget_automation.db)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_stdout()
    parser = build_parser()
    args = parser.parse_args(argv)

    db_path = args.db.expanduser()
    if not db_path.is_absolute():
        db_path = Path.cwd() / db_path

    if not db_path.exists():
        print(f"Database not found: {db_path}", file=sys.stderr)
        return 1

    try:
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = fetch_breakdown(conn, args.since, args.status)
    except (sqlite3.Error, RuntimeError) as exc:
        print(f"Cannot build feedback report: {exc}", file=sys.stderr)
        return 1

    print_report(rows, args.since, args.status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
