from datetime import date

from sperrmuell.dates import (
    format_de, month_from_de, pickup_to_putout, putout_to_pickup, window,
)  # fmt: skip
from sperrmuell.schedule import Stop, streets_for_putout


def test_shift_rule_d_minus_1():
    # вывоз AWG 14-го -> выставить 13-го
    assert pickup_to_putout(date(2026, 12, 14)) == date(2026, 12, 13)
    assert putout_to_pickup(date(2026, 12, 13)) == date(2026, 12, 14)


def test_shift_crosses_month_and_year():
    assert pickup_to_putout(date(2027, 1, 1)) == date(2026, 12, 31)
    assert putout_to_pickup(date(2026, 11, 30)) == date(2026, 12, 1)


def test_window_first_day_is_entered_date():
    w = window(date(2026, 11, 29))
    assert len(w) == 7 and w[0] == date(2026, 11, 29) and w[-1] == date(2026, 12, 5)


def test_german_months():
    assert month_from_de("März") == 3 and month_from_de("dezember") == 12
    assert month_from_de("Foo") is None
    assert format_de(date(2026, 11, 29)) == "29 November 2026"


SCHEDULE = {
    "streets": {
        "Bachstr": {"dates": ["2026-11-30"]},
        "Adolf-Vorwerk-Str": {"dates": [], "houses": {"107a": ["2026-11-30"], "16": ["2026-11-30"], "19": ["2026-12-14"]}},
        "Zoo": {"dates": ["2026-12-14"]},
    }
}  # fmt: skip


def test_streets_for_putout_applies_shift_and_sorts():
    # AWG 30 ноября -> выставляют 29 ноября
    assert streets_for_putout(SCHEDULE, date(2026, 11, 29)) == [
        Stop("Adolf-Vorwerk-Str", ("16", "107a")),
        Stop("Bachstr"),
    ]
    # а сам 30 ноября в списке не должен появиться
    assert streets_for_putout(SCHEDULE, date(2026, 11, 30)) == []


def test_streets_for_putout_month_boundary():
    assert [s.name for s in streets_for_putout(SCHEDULE, date(2026, 12, 13))] == [
        "Adolf-Vorwerk-Str",
        "Zoo",
    ]
