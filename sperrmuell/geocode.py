"""Координаты улиц: web/data/coords.json  {"Achenbachstr": [lat, lon]}.

1. Берём готовые координаты из старого geocode_cache.json (--seed), ключи вида "Улица, Wuppertal".
2. Недостающие геокодируем: Nominatim (лимит 1 запрос/сек, фильтр «только улицы»),
   затем Photon как запасной вариант. Результат обязан лежать в рамке Wuppertal.
3. Неудачи запоминаются (geocode_failed.json) и не повторяются чаще раза в 60 дней.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from .build_schedule import atomic_write_json, load_json

log = logging.getLogger("geocode")

CITY = "Wuppertal"
# Рамка города: защита от улиц-однофамильцев в других городах.
BBOX = (51.14, 7.00, 51.33, 7.32)  # lat_min, lon_min, lat_max, lon_max
RETRY_FAILED_AFTER = timedelta(days=60)

FORBIDDEN_TYPES = {
    "track", "path", "cycleway", "footway", "bridleway", "construction",
    "transportation", "halt", "locality", "platform", "neighbourhood",
}  # fmt: skip
FORBIDDEN_KEYS = (
    "waterway", "stream", "river", "canal", "harbour", "forest", "allotments",
    "leisure", "garden", "cemetery", "industrial", "landuse", "farm", "village_green",
    "nature_reserve", "peak", "island", "islet", "public_building", "historic",
    "square", "locality", "platform",
)  # fmt: skip


def in_bbox(lat: float, lon: float) -> bool:
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def is_valid_address(address: dict, osm_type: str | None) -> bool:
    """Улица или дом, но не тропа, река, лес и т.п. (правила из старого main.py)."""
    if not isinstance(address, dict):
        return False
    if osm_type in FORBIDDEN_TYPES:
        return False
    if any(address.get(k) for k in FORBIDDEN_KEYS):
        return False
    return any(address.get(k) for k in ("road", "street", "residential"))


class Geocoder:
    def __init__(self, user_agent: str, nominatim_delay: float = 1.2):
        self.s = requests.Session()
        self.s.headers["User-Agent"] = user_agent
        self.delay = nominatim_delay
        self._last = 0.0

    def _get(self, url: str, params: dict, attempts: int = 5):
        for i in range(attempts):
            wait = self._last + self.delay - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                r = self.s.get(url, params=params, timeout=15)
                if r.status_code == 429 or r.status_code >= 500:
                    time.sleep(min(30 * (i + 1), 120))
                    continue
                r.raise_for_status()
                return r.json()
            except (requests.RequestException, ValueError) as e:
                log.warning("%s: %s", url, e)
                time.sleep(5 * (i + 1))
        return None

    def nominatim(self, street: str) -> tuple[float, float] | None:
        data = self._get(
            "https://nominatim.openstreetmap.org/search",
            {
                "q": f"{street}, {CITY}", "format": "jsonv2", "addressdetails": 1,
                "limit": 5, "countrycodes": "de",
            },
        )  # fmt: skip
        for item in data or []:
            lat, lon = float(item["lat"]), float(item["lon"])
            if in_bbox(lat, lon) and is_valid_address(item.get("address", {}), item.get("type")):
                return lat, lon
        return None

    def photon(self, street: str) -> tuple[float, float] | None:
        data = self._get("https://photon.komoot.io/api/", {"q": f"{street}, {CITY}", "limit": 3})
        for f in (data or {}).get("features", []):
            lon, lat = f["geometry"]["coordinates"]
            if in_bbox(lat, lon):
                return lat, lon
        return None


def seed_from_cache(path: Path, streets: list[str]) -> dict[str, list[float]]:
    cache = load_json(path, {})
    out = {}
    for s in streets:
        v = cache.get(f"{s}, {CITY}")
        if v and in_bbox(v[0], v[1]):
            out[s] = [round(v[0], 6), round(v[1], 6)]
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--streets", default="web/data/streets.json")
    p.add_argument("--out", default="web/data/coords.json")
    p.add_argument("--failed", default="data/geocode_failed.json")
    p.add_argument("--seed", help="старый geocode_cache.json")
    p.add_argument("--schedule", default="web/data/schedule.json", help="откуда брать дома с отдельными календарями")
    p.add_argument("--house-seed", default="data/source/house_coords_seed.json")
    p.add_argument("--limit", type=int)
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    streets = [s["name"] for s in load_json(Path(args.streets), [])]
    out_path, failed_path = Path(args.out), Path(args.failed)
    coords: dict = load_json(out_path, {})
    failed: dict = load_json(failed_path, {})

    if args.seed:
        for k, v in seed_from_cache(Path(args.seed), streets).items():
            coords.setdefault(k, v)
        log.info("После seed: %d координат", len(coords))

    # дома с отдельными календарями: ключ "Улица 12a". Берём из сида (старый кэш), без сети;
    # для домов без координат приложение рисует точку улицы.
    house_seed = load_json(Path(args.house_seed), {})
    schedule = load_json(Path(args.schedule), {"streets": {}})
    wanted = {
        f"{name} {h}"
        for name, entry in schedule.get("streets", {}).items()
        for h in (entry.get("houses") or {})
    }
    added = 0
    for key in wanted:
        if key not in coords and key in house_seed:
            coords[key] = house_seed[key]
            added += 1
    log.info("Дома: нужно %d, из сида добавлено %d, без точки (будет точка улицы) %d",
             len(wanted), added, sum(1 for k in wanted if k not in coords))

    now = datetime.now(timezone.utc)
    todo = []
    for s in streets:
        if s in coords:
            continue
        ts = failed.get(s)
        if ts and now - datetime.fromisoformat(ts) < RETRY_FAILED_AFTER:
            continue
        todo.append(s)
    if args.limit is not None:
        todo = todo[: args.limit]
    log.info("К геокодированию: %d", len(todo))

    if todo:
        ua = os.getenv("NOMINATIM_USER_AGENT", "wuppertal-sperrmuell/1.0 (github.com/routefromhome-collab)")
        geo = Geocoder(ua)
        for n, s in enumerate(todo, start=1):
            res = geo.nominatim(s) or geo.photon(s)
            if res:
                coords[s] = [round(res[0], 6), round(res[1], 6)]
                failed.pop(s, None)
            else:
                failed[s] = now.isoformat()
                log.warning("Не найдено: %s", s)
            if n % 25 == 0:  # сохраняемся по ходу: прогон на Actions длинный
                atomic_write_json(out_path, coords)
                atomic_write_json(failed_path, failed)
                log.info("Прогресс %d/%d", n, len(todo))

    atomic_write_json(out_path, coords)
    atomic_write_json(failed_path, failed)
    log.info("Готово: %d из %d улиц с координатами", sum(1 for s in streets if s in coords), len(streets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
