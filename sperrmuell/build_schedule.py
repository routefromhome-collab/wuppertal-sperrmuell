"""Сборка web/data/schedule.json: даты вывоза Sperrmüll по всем улицам.

Один запрос на улицу отдаёт календарь целиком, поэтому парсим «все даты сразу»,
а окно в 7 дней и сдвиг D-1 считаются уже на клиенте. Это в разы меньше запросов к AWG,
чем старая схема «улица x день», и данные не нужно пересобирать при каждом вводе даты.

Защита данных: при сбое улицы остаются прежние записи; если сбоев больше порога
(например, AWG сменил вёрстку), файл не перезаписывается и скрипт завершается с кодом 2.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .awg import AwgClient, StreetResult

log = logging.getLogger("build_schedule")

SCHEMA_VERSION = 1


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def atomic_write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def entry_from_result(res: StreetResult, now_iso: str) -> dict:
    entry: dict = {"fetched": now_iso, "dates": [d.isoformat() for d in res.dates]}
    if res.status == "not_found":
        entry["not_found"] = True  # в AWG такой улицы нет: не считаем сбоем и не перезапрашиваем до срока
    if res.covered_until:
        entry["until"] = res.covered_until.isoformat()
    if res.houses:
        entry["houses"] = {h: [d.isoformat() for d in ds] for h, ds in res.houses.items()}
    return entry


def is_fresh(entry: dict | None, max_age: timedelta, now: datetime) -> bool:
    if not entry or "fetched" not in entry:
        return False
    try:
        return now - datetime.fromisoformat(entry["fetched"]) < max_age
    except ValueError:
        return False


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--streets", default="web/data/streets.json")
    p.add_argument("--out", default="web/data/schedule.json")
    p.add_argument("--max-age-days", type=float, default=25, help="свежие записи не перезапрашиваем")
    p.add_argument("--force", action="store_true", help="игнорировать возраст записей")
    p.add_argument("--only", help="только эта улица (для отладки)")
    p.add_argument("--limit", type=int, help="не больше N улиц (для испытаний)")
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--min-delay", type=float, default=0.12, help="пауза между запросами, сек")
    p.add_argument("--max-fail-ratio", type=float, default=0.05)
    p.add_argument("--min-fail-count", type=int, default=3, help="порог сбоев срабатывает, только если их не меньше N")
    p.add_argument("--debug-dir", help="сохранять HTML нераспознанных страниц и образцы сюда")
    p.add_argument("--dry-run", action="store_true", help="не записывать файл")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    out = Path(args.out)
    streets = [s["name"] for s in load_json(Path(args.streets), [])]
    if not streets:
        log.error("Список улиц пуст: %s", args.streets)
        return 1
    if args.only:
        streets = [s for s in streets if s == args.only]

    schedule = load_json(out, {"version": SCHEMA_VERSION, "streets": {}})
    known: dict = schedule.setdefault("streets", {})
    now = datetime.now(timezone.utc).replace(microsecond=0)
    max_age = timedelta(days=args.max_age_days)

    todo = [s for s in streets if args.force or not is_fresh(known.get(s), max_age, now)]
    if args.limit is not None:
        todo = todo[: args.limit]
    log.info("Улиц всего: %d, к обновлению: %d", len(streets), len(todo))
    if not todo:
        return 0

    client = AwgClient(min_delay=args.min_delay, debug_dir=args.debug_dir)
    client.load_form()

    updated: dict[str, dict] = {}
    failed: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(client.fetch_street, s): s for s in todo}
        for n, fut in enumerate(as_completed(futures), start=1):
            street = futures[fut]
            try:
                res = fut.result()
            except Exception as e:  # noqa: BLE001 - не роняем весь прогон из-за одной улицы
                log.exception("%s: %s", street, e)
                res = StreetResult("error")
            if res.status in ("ok", "not_found"):
                updated[street] = entry_from_result(res, now.isoformat())
            else:
                failed[street] = res.status
            if n % 100 == 0 or n == len(todo):
                log.info("Прогресс %d/%d, запросов к AWG: %d", n, len(todo), client.requests_made)

    missing = sorted(s for s, e in updated.items() if e.get("not_found"))
    for street in missing[:30]:
        log.info("Нет в AWG: %s", street)
    if len(missing) >= 10 and len(missing) / len(todo) > 0.2:
        log.error("Слишком много улиц «не найдено» (%d из %d): вероятно, изменилась форма поиска", len(missing), len(todo))
        return 2

    ratio = len(failed) / len(todo)
    for street, status in sorted(failed.items())[:30]:
        log.warning("Сбой: %s -> %s", street, status)
    log.info("Успешно: %d, сбоев: %d (%.1f%%)", len(updated), len(failed), ratio * 100)

    if ratio > args.max_fail_ratio and len(failed) >= args.min_fail_count:
        log.error("Сбоев больше порога %.0f%%, файл НЕ перезаписан", args.max_fail_ratio * 100)
        return 2

    known.update(updated)
    untils = [e["until"] for e in known.values() if e.get("until")]
    schedule.update(
        version=SCHEMA_VERSION,
        generated_at=now.isoformat(),
        pickup_to_putout_shift_days=1,
        failed=sorted(failed),
        not_found=sorted(s for s, e in known.items() if e.get("not_found")),
        covered_until=min(untils) if untils else None,  # граница публикации календаря AWG
    )
    if args.dry_run:
        log.info("dry-run: запись пропущена")
        return 0
    atomic_write_json(out, schedule)
    log.info("Записано: %s", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
