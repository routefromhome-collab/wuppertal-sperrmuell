"""Паритет с последним рабочим парсером (main.py, check_calendar): те же даты на тех же страницах.

check_calendar ниже скопирован из старого main.py без изменений логики (только current_month/current_day
стали аргументами). Если оба парсера согласны на каждом дне каждого месяца реальных страниц AWG,
новый разбор не потерял и не добавил ни одной даты.
"""

import re
from datetime import date, timedelta
from pathlib import Path

from bs4 import BeautifulSoup

from sperrmuell.awg import parse_calendar
from sperrmuell.dates import MONTHS_DE

FIX = Path(__file__).parent / "fixtures"


def check_calendar_legacy(calendar_soup, current_month, current_day):
    requested_month = str(current_month).strip().casefold()
    for month_div in calendar_soup.select("div.month"):
        header = month_div.select_one(".info h3")
        if not header:
            header = month_div.find(["h3", "span"])
        if not header:
            continue
        normalized_header = header.get_text(" ", strip=True).casefold()
        if normalized_header != requested_month:
            if not normalized_header.startswith(requested_month + " "):
                continue
        for row in month_div.select("tr.day"):
            date_span = row.select_one("span.weekday")
            if not date_span:
                continue
            match = re.search(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b", date_span.get_text(" ", strip=True))
            if not match:
                continue
            day, _month, _year = match.groups()
            if int(day) != int(current_day):
                continue
            if row.select_one('i[title="Sperrmüll"]'):
                return True
    return False


def test_same_dates_as_legacy_on_every_day():
    pages = sorted(FIX.glob("awg_calendar_*.html"))
    assert len(pages) == 3
    for page in pages:
        html = page.read_text(encoding="utf-8")
        soup = BeautifulSoup(html, "lxml")
        new = set(parse_calendar(html))
        d, end = date(2026, 11, 1), date(2027, 4, 30)
        legacy = set()
        while d <= end:
            if check_calendar_legacy(soup, f"{MONTHS_DE[d.month - 1]} {d.year}", d.day):
                legacy.add(d)
            d += timedelta(days=1)
        assert new == legacy and new, page.name
