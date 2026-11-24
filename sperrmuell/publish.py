"""Публикация списка улиц в Telegram-канал на 7 дней вперёд от введённой даты.

Запускается вручную (workflow «Publish»): расписания нет, список выходит только когда
владелец вводит дату. Парсинг AWG здесь не выполняется: данные берутся из schedule.json.
Формат сообщения прежний (🗑 Шпера …, ссылки map, маршруты, #шпера) плюс ссылка на Mini App.
"""

from __future__ import annotations

import argparse
import html
import json
import logging
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

from .dates import format_de, parse_iso, window
from .routing import google_route_links, order_points
from .schedule import Stop, streets_for_putout
from .tgapi import chunk_text, notify_admin, send_message

log = logging.getLogger("publish")
CITY = "Wuppertal"
STALE_AFTER = timedelta(days=45)


def build_day_message(day: date, stops: list[Stop], coords: dict, miniapp_url: str | None) -> str:
    title = format_de(day)
    if not stops:
        return f"✅ {title} выходной.\n\n#шпера"

    lines = [f"🗑 <b>Шпера {title}:</b>\n"]
    for stop in stops:
        # как в рабочем main.py: только название улицы (номера домов в пост не выводятся)
        q = quote(f"{stop.name}, {CITY}", safe="")
        lines.append(f'{html.escape(stop.name)} <a href="https://www.google.com/maps/search/?api=1&query={q}">map</a>')

    # маршрут: точки с координатами по TSP, остальные в конец по алфавиту
    with_xy = [s for s in stops if s.name in coords]
    without = [s for s in stops if s.name not in coords]
    order = order_points([tuple(coords[s.name]) for s in with_xy])
    names = [with_xy[i].name for i in order] + [s.name for s in without]
    for n, link in enumerate(google_route_links([f"{n}, {CITY}" for n in names]), start=1):
        lines.append(f'\n🗺 Маршрут (часть {n}): <a href="{link}">map</a>')

    if miniapp_url:
        sep = "&" if "?" in miniapp_url else "?"
        lines.append(f'\n📍Полная карта на {title}: <a href="{miniapp_url}{sep}startapp={day.isoformat()}">map</a>')
    lines.append("\n#шпера")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--start", required=True, help="первый день выставления, YYYY-MM-DD")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--schedule", default="web/data/schedule.json")
    p.add_argument("--coords", default="web/data/coords.json")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    start = parse_iso(args.start)
    schedule = json.loads(Path(args.schedule).read_text(encoding="utf-8"))
    coords = json.loads(Path(args.coords).read_text(encoding="utf-8")) if Path(args.coords).exists() else {}

    gen = schedule.get("generated_at")
    if gen and datetime.now(timezone.utc) - datetime.fromisoformat(gen) > STALE_AFTER:
        log.warning("Данные старше %d дней, сначала запустите Update schedule", STALE_AFTER.days)
        notify_admin(f"⚠️ Publish: schedule.json устарел (generated_at={gen})")

    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")
    if not args.dry_run and not (token and chat):
        log.error("Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID")
        return 1
    miniapp_url = os.getenv("MINIAPP_URL")

    for day in window(start, args.days):
        text = build_day_message(day, streets_for_putout(schedule, day), coords, miniapp_url)
        if args.dry_run:
            print(text, "\n" + "-" * 40)
            continue
        for chunk in chunk_text(text):
            if not send_message(token, chat, chunk):
                notify_admin(f"❌ Publish: не удалось отправить день {day.isoformat()}")
                return 1
            time.sleep(0.3)
    return 0


if __name__ == "__main__":
    sys.exit(main())
