"""
ЯДРО HTTP — вендорная копия из навыка open-data-harvester (scripts/rest_client.py).

Скопировано в модуль НАМЕРЕННО: на проде (5.42.103.63) каталога ~/.claude/skills нет,
поэтому рецепты навыка лежат рядом с кодом — модуль самодостаточен. НЕ изобретаем
HTTP-клиент заново: берём готовый слой с ретраями/бэкоффом/кэшем сырья/провенансом.

Зачем он нужен. Любой сбор по сети упирается в одни и те же вещи: заголовки,
таймауты, повторы при сбое, вежливые паузы, кэш сырья на диск.

Все адреса и ключи — через переменные окружения (.env). Секреты в код НЕ зашиваем.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import time
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

# --- настройки из окружения (плейсхолдеры — подставь свои значения) ---
BASE_URL = os.environ.get("BASE_URL", "https://BASE_URL")        # роль: открытый API/сайт источника
API_KEY = os.environ.get("API_KEY", "")                          # секрет: только из окружения
SOURCE_LABEL = os.environ.get("SOURCE_LABEL", "source-label")    # короткая метка источника для провенанса
CACHE_DIR = Path(os.environ.get("CACHE_DIR", "out/cache"))
MIN_DELAY_SEC = float(os.environ.get("MIN_DELAY_SEC", "2.0"))    # минимальная пауза между «живыми» запросами
TIMEOUT_SEC = float(os.environ.get("TIMEOUT_SEC", "30"))
MAX_RETRIES = int(os.environ.get("MAX_RETRIES", "5"))

# Реалистичный User-Agent. Свой можно задать через окружение. Это НЕ обход защиты,
# а корректное представление клиента; почему он важен — см. references/anti_bot.md.
USER_AGENT = os.environ.get(
    "USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
)

_last_call_ts = 0.0  # время последнего «живого» запроса (для вежливой паузы)


def default_headers(accept: str = "application/json") -> dict[str, str]:
    """Базовые заголовки. Authorization добавляем только если задан API_KEY."""
    h = {
        "User-Agent": USER_AGENT,
        "Accept": accept,
        "Accept-Language": os.environ.get("ACCEPT_LANGUAGE", "ru-RU,ru;q=0.9"),
    }
    referer = os.environ.get("REFERER")
    if referer:
        h["Referer"] = referer
    if API_KEY:
        h["Authorization"] = f"Bearer {API_KEY}"
    return h


def _cache_path(method: str, url: str, params: dict | None, body: Any) -> Path:
    """Уникальное имя файла кэша из метода+адреса+параметров (хэш, без коллизий)."""
    key = json.dumps([method, url, params, body], sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]
    host = urlparse(url).hostname or "host"
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / f"{host}-{digest}.raw"


def _polite_pause() -> None:
    """Держим минимальную паузу между живыми запросами — не «душим» источник."""
    global _last_call_ts
    wait = MIN_DELAY_SEC - (time.monotonic() - _last_call_ts)
    if wait > 0:
        time.sleep(wait)
    _last_call_ts = time.monotonic()


def request(
    method: str,
    path_or_url: str,
    *,
    params: dict | None = None,
    json_body: Any = None,
    accept: str = "application/json",
    use_cache: bool = True,
) -> httpx.Response:
    """
    Один сетевой запрос со всеми гарантиями слоя.

    method      — "GET" / "POST" и т.п.
    path_or_url — путь ("/api/v1/items") или полный URL. Путь клеится к BASE_URL.
    use_cache   — если ответ уже снят и лежит в кэше, берём из файла (без сети).
    """
    url = path_or_url if path_or_url.startswith("http") else f"{BASE_URL}{path_or_url}"
    cache_file = _cache_path(method, url, params, json_body)

    if use_cache and cache_file.exists():
        raw = cache_file.read_bytes()
        return httpx.Response(200, content=raw, request=httpx.Request(method, url))

    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        _polite_pause()
        try:
            resp = httpx.request(
                method, url, params=params, json=json_body,
                headers=default_headers(accept), timeout=TIMEOUT_SEC,
                follow_redirects=True,
            )
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:
                backoff = min(60.0, 2 ** attempt) + random.random()
                retry_after = resp.headers.get("Retry-After")
                if retry_after and retry_after.isdigit():
                    backoff = max(backoff, float(retry_after))
                print(f"  [{resp.status_code}] попытка {attempt}/{MAX_RETRIES}, ждём {backoff:.1f}с")
                time.sleep(backoff)
                continue
            resp.raise_for_status()
            if use_cache:
                cache_file.write_bytes(resp.content)
            return resp
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            last_exc = exc
            if attempt < MAX_RETRIES:
                backoff = min(60.0, 2 ** attempt) + random.random()
                print(f"  [сеть] попытка {attempt}/{MAX_RETRIES}: {exc}. Ждём {backoff:.1f}с")
                time.sleep(backoff)
            else:
                raise
    assert last_exc is not None
    raise last_exc


def get_json(path_or_url: str, *, params: dict | None = None, use_cache: bool = True) -> Any:
    """Короткий путь: GET → разобранный JSON."""
    return request("GET", path_or_url, params=params, use_cache=use_cache).json()


def provenance(source_url: str, *, source_label: str | None = None,
               period_covered: str | None = None) -> dict[str, str]:
    """
    Паспорт источника. ПРИКЛЕИВАЙ его к каждой записи — без него данные «висят в
    воздухе»: непонятно откуда, на какую дату, можно ли доверять.
    Подробнее зачем — references/provenance.md.
    """
    p = {
        "source": source_label or SOURCE_LABEL,
        "source_url": source_url,
        "snapshot_date": date.today().isoformat(),  # дата снимка = когда сняли
    }
    if period_covered:
        p["period_covered"] = period_covered
    return p
