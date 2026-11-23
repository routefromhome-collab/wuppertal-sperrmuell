"""Работа с датами. Единственное место в Python-коде, где живёт правило D-1.

Правило (намеренное, не менять):
    AWG вывозит Sperrmüll в день P  ->  жители выставляют его в день P-1.
    Во всех списках, уведомлениях и на карте показывается день выставления (P-1).

В данных (schedule.json) хранятся «сырые» даты вывоза AWG (P): это правда источника.
Сдвиг применяется только при отображении, через функции этого модуля.
"""

from __future__ import annotations

from datetime import date, timedelta

PUTOUT_SHIFT_DAYS = 1

MONTHS_DE = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
]  # fmt: skip

_MONTH_INDEX = {name.lower(): i for i, name in enumerate(MONTHS_DE, start=1)}
_MONTH_INDEX.update({"maerz": 3, "marz": 3})


def month_from_de(name: str) -> int | None:
    """'November' -> 11. Регистр не важен. Неизвестное имя -> None."""
    return _MONTH_INDEX.get(name.strip().lower())


def pickup_to_putout(pickup: date) -> date:
    """День вывоза AWG -> день, когда жители выставляют Sperrmüll."""
    return pickup - timedelta(days=PUTOUT_SHIFT_DAYS)


def putout_to_pickup(putout: date) -> date:
    """День выставления -> день вывоза AWG (по какой дате искать в календаре)."""
    return putout + timedelta(days=PUTOUT_SHIFT_DAYS)


def window(start: date, days: int = 7) -> list[date]:
    """Окно из `days` дней выставления; введённая дата = день 1."""
    return [start + timedelta(days=i) for i in range(days)]


def format_de(d: date) -> str:
    """29 November 2026 — формат, к которому привыкли подписчики канала."""
    return f"{d.day} {MONTHS_DE[d.month - 1]} {d.year}"


def parse_iso(value: str) -> date:
    return date.fromisoformat(value)
