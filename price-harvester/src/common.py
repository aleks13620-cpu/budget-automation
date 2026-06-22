"""
Общая обвязка модуля price-harvester: пути, загрузка .env, доступ к вендорным
рецептам навыка. Импортируй ЭТОТ модуль ПЕРВЫМ — он:
  1) загружает .env в окружение (до импорта rest_client, который читает env при импорте);
  2) задаёт стабильные пути кэша/вывода (не зависят от текущей папки запуска);
  3) кладёт harvester/ в sys.path, чтобы `import rest_client` / `import feed_xml` работали.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]      # .../budget-automation/price-harvester
HARVESTER = ROOT / "harvester"
OUT = ROOT / "out"


def _load_env() -> None:
    """Простейший разбор .env (без зависимости python-dotenv). Реальные env-переменные
    имеют приоритет над файлом (setdefault)."""
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

    # Стабильные пути по умолчанию (не зависят от CWD).
    os.environ.setdefault("CACHE_DIR", str(OUT / "cache"))
    os.environ.setdefault("OUT_DIR", str(OUT))
    # Общая SQLite: по умолчанию — соседняя БД бэкенда.
    os.environ.setdefault("BUDGET_DB_PATH", str((ROOT.parent / "database" / "budget_automation.db")))


_load_env()
OUT.mkdir(parents=True, exist_ok=True)

if str(HARVESTER) not in sys.path:
    sys.path.insert(0, str(HARVESTER))


def read_out_json(filename: str):
    """Прочитать артефакт out/<filename>. Нет файла → понятная ошибка (шаг не запускался)."""
    path = OUT / filename
    if not path.exists():
        raise SystemExit(f"Нет {filename}. Сначала запусти предыдущий шаг (run.py).")
    return json.loads(path.read_text(encoding="utf-8"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def today() -> str:
    return datetime.now(timezone.utc).date().isoformat()
