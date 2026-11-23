from datetime import date
from pathlib import Path

from sperrmuell.awg import (
    AwgClient, PageKind, classify_page, extract_links, normalize_street_name, parse_calendar,
)  # fmt: skip

FIX = Path(__file__).parent / "fixtures"


def read(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


def test_calendar_only_sperrmuell_icons_all_months():
    # Restmüll (1 дек) и дни без иконки не считаются; заголовок может быть h3 или span
    assert parse_calendar(read("calendar_street.html")) == [
        date(2026, 11, 30), date(2026, 12, 14), date(2027, 3, 3),
    ]  # fmt: skip


def test_house_table_calendar():
    assert parse_calendar(read("house_calendar_table.html")) == [
        date(2026, 11, 13), date(2026, 11, 30),
    ]  # fmt: skip


def test_classification():
    assert classify_page(read("calendar_street.html")) is PageKind.CALENDAR
    assert classify_page(read("house_calendar_table.html")) is PageKind.CALENDAR
    assert classify_page(read("houses_street.html")) is PageKind.HOUSES
    assert classify_page(read("similar_streets.html")) is PageKind.SIMILAR
    assert classify_page(read("unknown.html")) is PageKind.UNKNOWN


def test_extract_links_are_absolute():
    links = extract_links(read("houses_street.html"), "https://awg-wuppertal.de/x/y.html")
    assert [t for t, _ in links] == ["16", "19", "107a"]
    assert all(u.startswith("https://awg-wuppertal.de/privatkunden/") for _, u in links)


def test_normalize_street_name():
    n = normalize_street_name
    assert n("Hohlenscheidter Str.") == n("hohlenscheidter strasse") == n("Hohlenscheidter Straße")
    assert n("Adolf-Vorwerk-Str.") == n("adolf vorwerk str")


class FakeClient(AwgClient):
    """AwgClient без сети: страницы отдаются из словаря."""

    def __init__(self, pages: dict[str, str]):
        super().__init__()
        self.pages = pages

    def _request(self, method, url, **kw):  # noqa: ANN001
        if method == "POST":
            return self.pages["POST"]
        return self.pages.get(url)


def test_fetch_street_with_houses():
    pages = {"POST": read("houses_street.html")}
    for _, link in extract_links(read("houses_street.html"), "https://awg-wuppertal.de/privatkunden/abfallkalender.html"):
        pages[link] = read("house_calendar_table.html")
    res = FakeClient(pages).fetch_street("Adolf-Vorwerk-Str")
    assert res.status == "ok" and set(res.houses) == {"16", "19", "107a"}
    assert res.houses["16"] == [date(2026, 11, 13), date(2026, 11, 30)]


def test_fetch_street_via_similar_list():
    base = "https://awg-wuppertal.de/privatkunden/abfallkalender.html"
    link = extract_links(read("similar_streets.html"), base)[0][1]
    res = FakeClient({"POST": read("similar_streets.html"), link: read("calendar_street.html")}).fetch_street(
        "hohlenscheidter strasse"
    )
    assert res.status == "ok" and res.dates[0] == date(2026, 11, 30)


def test_fetch_street_not_found_and_unrecognized():
    assert FakeClient({"POST": read("similar_streets.html")}).fetch_street("Gibtesnicht").status == "not_found"
    assert FakeClient({"POST": read("unknown.html")}).fetch_street("X").status == "unrecognized"


def test_debug_dump_saves_unrecognized_and_limits_samples(tmp_path):
    bad = FakeClient({"POST": read("unknown.html")})
    bad.debug_dir = str(tmp_path)
    bad.fetch_street("Achenbachtreppe")
    assert (tmp_path / "unknown__Achenbachtreppe.html").exists()

    good = FakeClient({"POST": read("calendar_street.html")})
    good.debug_dir = str(tmp_path)
    for i in range(6):
        good.fetch_street(f"S{i}")
    assert len(list(tmp_path.glob("calendar__*.html"))) == 3  # не больше 3 образцов
