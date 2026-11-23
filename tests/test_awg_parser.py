"""Парсер AWG. awg_*.html: настоящие страницы awg-wuppertal.de (golden, сняты 2026-11-23).
legacy_*.html: синтетика по старой вёрстке (запасной разбор)."""

from datetime import date
from pathlib import Path

from sperrmuell.awg import (
    AwgClient, PageKind, calendar_coverage, classify_page, extract_links, normalize_street_name, parse_calendar,
)  # fmt: skip

FIX = Path(__file__).parent / "fixtures"
BASE = "https://awg-wuppertal.de/privatkunden/abfallkalender.html"


def read(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


# ---------- настоящая вёрстка ----------
def test_real_calendars_exact_dates():
    assert parse_calendar(read("awg_calendar_achenbachstr.html")) == [date(2026, 11, 25), date(2027, 3, 3)]
    assert parse_calendar(read("awg_calendar_achterbergweg.html")) == [date(2026, 11, 30), date(2027, 3, 8)]
    assert parse_calendar(read("awg_calendar_adersstr.html")) == [date(2026, 12, 23), date(2027, 4, 8)]


def test_real_calendar_ignores_50_percent_bin_icon():
    # «Restmüll, 50% reduziert» раньше давало «день 50»; теперь число берётся только из dd.mm.yyyy
    dates = parse_calendar(read("awg_calendar_achenbachstr.html"))
    assert all(1 <= d.day <= 31 for d in dates)


def test_real_calendar_coverage_is_end_of_last_month():
    assert calendar_coverage(read("awg_calendar_achenbachstr.html")) == date(2027, 4, 30)


def test_real_page_kinds():
    assert classify_page(read("awg_calendar_adersstr.html")) is PageKind.CALENDAR
    assert classify_page(read("awg_houses_adamsbusch.html")) is PageKind.HOUSES
    assert classify_page(read("awg_similar_albenstr.html")) is PageKind.SIMILAR
    assert classify_page(read("awg_not_found.html")) is PageKind.NOT_FOUND


def test_real_house_links():
    links = extract_links(read("awg_houses_adamsbusch.html"), BASE)
    assert [t for t, _ in links][:4] == ["1", "6", "9", "11"] and len(links) == 18
    assert all(u.startswith("https://awg-wuppertal.de/privatkunden/") for _, u in links)


def test_real_similar_links():
    assert [t for t, _ in extract_links(read("awg_similar_albenstr.html"), BASE)] == ["Albenstraße", "Schwalbenstraße"]


class FakeClient(AwgClient):
    """AwgClient без сети: страницы отдаются из словаря."""

    def __init__(self, pages: dict[str, str]):
        super().__init__()
        self.pages = pages

    def _request(self, method, url, **kw):  # noqa: ANN001
        return self.pages["POST"] if method == "POST" else self.pages.get(url)


def test_fetch_street_plain_calendar():
    res = FakeClient({"POST": read("awg_calendar_adersstr.html")}).fetch_street("Adersstr")
    assert res.status == "ok" and res.dates == [date(2026, 12, 23), date(2027, 4, 8)]
    assert res.covered_until == date(2027, 4, 30)


def test_fetch_street_with_houses():
    pages = {"POST": read("awg_houses_adamsbusch.html")}
    for _, link in extract_links(pages["POST"], BASE):
        pages[link] = read("awg_calendar_achenbachstr.html")
    res = FakeClient(pages).fetch_street("Adamsbusch")
    assert res.status == "ok" and len(res.houses) == 18 and "23a" in res.houses
    assert res.houses["1"] == [date(2026, 11, 25), date(2027, 3, 3)]


def test_fetch_street_via_similar_list():
    link = next(u for t, u in extract_links(read("awg_similar_albenstr.html"), BASE) if t == "Albenstraße")
    res = FakeClient({"POST": read("awg_similar_albenstr.html"), link: read("awg_calendar_adersstr.html")}).fetch_street("Albenstr")
    assert res.status == "ok" and res.dates[0] == date(2026, 12, 23)


def test_fetch_street_not_found():
    assert FakeClient({"POST": read("awg_not_found.html")}).fetch_street("Achenbachtreppe").status == "not_found"
    assert FakeClient({"POST": read("awg_similar_albenstr.html")}).fetch_street("Gibtesnicht").status == "not_found"


def test_fetch_street_unrecognized_when_site_looks_different():
    assert FakeClient({"POST": read("legacy_unknown.html")}).fetch_street("X").status == "unrecognized"


def test_normalize_street_name():
    n = normalize_street_name
    assert n("Albenstr") == n("Albenstraße") == n("albenstrasse")
    assert n("Adolf-Vorwerk-Str.") == n("adolf vorwerk str")


# ---------- запасной разбор старой вёрстки ----------
def test_legacy_calendar_and_table():
    assert parse_calendar(read("legacy_calendar_street.html")) == [date(2026, 11, 30), date(2026, 12, 14), date(2027, 3, 3)]
    assert parse_calendar(read("legacy_house_calendar_table.html")) == [date(2026, 11, 13), date(2026, 11, 30)]
    assert classify_page(read("legacy_calendar_street.html")) is PageKind.CALENDAR


# ---------- диагностика ----------
def test_debug_dump_saves_unrecognized_and_limits_samples(tmp_path):
    bad = FakeClient({"POST": read("legacy_unknown.html")})
    bad.debug_dir = str(tmp_path)
    bad.fetch_street("Wartung")
    assert (tmp_path / "unknown__Wartung.html").exists()

    good = FakeClient({"POST": read("awg_calendar_adersstr.html")})
    good.debug_dir = str(tmp_path)
    for i in range(6):
        good.fetch_street(f"S{i}")
    assert len(list(tmp_path.glob("calendar__*.html"))) == 3
