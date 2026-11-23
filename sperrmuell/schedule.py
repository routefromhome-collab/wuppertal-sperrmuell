"""Выборка улиц на день выставления из schedule.json (зеркало web/js/schedule.js)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

from .dates import putout_to_pickup


@dataclass(frozen=True)
class Stop:
    name: str
    houses: tuple[str, ...] = ()  # пусто = улица целиком; иначе только эти дома


def natural_key(value: str):
    m = re.match(r"(\d+)(.*)", value)
    return (int(m.group(1)), m.group(2)) if m else (10**9, value)


def streets_for_putout(schedule: dict, putout: date) -> list[Stop]:
    """Улицы, где жители выставляют Sperrmüll в день `putout` (вывоз AWG на следующий день)."""
    target = putout_to_pickup(putout).isoformat()
    stops: list[Stop] = []
    for name, entry in schedule.get("streets", {}).items():
        if target in entry.get("dates", []):
            stops.append(Stop(name))
            continue
        houses = [h for h, ds in (entry.get("houses") or {}).items() if target in ds]
        if houses:
            stops.append(Stop(name, tuple(sorted(houses, key=natural_key))))
    return sorted(stops, key=lambda s: s.name.casefold())
