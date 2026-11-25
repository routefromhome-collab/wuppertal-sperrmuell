from datetime import date
from urllib.parse import unquote

from sperrmuell.publish import build_day_message
from sperrmuell.routing import distance_matrix, google_route_links, order_points, two_opt
from sperrmuell.schedule import Stop

LINE = [(51.0, 7.0), (51.0, 7.3), (51.0, 7.1), (51.0, 7.2)]  # на одной линии, вперемешку


def test_order_points_visits_all_once():
    order = order_points(LINE)
    assert sorted(order) == [0, 1, 2, 3]


def test_order_points_from_start_goes_monotonic():
    order = order_points(LINE, start=(51.0, 6.9))
    assert [LINE[i][1] for i in order] == [7.0, 7.1, 7.2, 7.3]


def test_two_opt_does_not_worsen():
    pts = [(51.0 + (i * 7919 % 13) / 100, 7.0 + (i * 104729 % 17) / 100) for i in range(25)]
    d = distance_matrix(pts)
    base = list(range(len(pts)))
    length = lambda r: sum(d[a][b] for a, b in zip(r, r[1:]))  # noqa: E731
    better = two_opt(base, d)
    assert sorted(better) == base and length(better) <= length(base) and better[0] == 0


def test_google_links_chunking_and_overlap():
    pts = [f"Street {i}, Wuppertal" for i in range(45)]
    links = google_route_links(pts, chunk=20)
    parts = [[unquote(p) for p in l.removeprefix("https://www.google.com/maps/dir/").strip("/").split("/")] for l in links]
    assert all(len(p) <= 20 for p in parts)
    assert parts[0][0] == pts[0] and parts[-1][-1] == pts[-1]
    assert parts[1][0] == parts[0][-1]  # части стыкуются
    assert {x for p in parts for x in p} == set(pts)  # ничего не потеряно


def test_google_links_empty_and_single():
    assert google_route_links([]) == []
    assert len(google_route_links(["A"])) == 1


def test_message_formats():
    coords = {"Bachstr": [51.25, 7.15]}
    day = date(2026, 11, 29)
    text = build_day_message(day, [Stop("Bachstr"), Stop("Adolf & Co", ("1", "2"))], coords, "https://site.test/map.html")
    assert "🗑 <b>Шпера 29 November 2026:</b>" in text
    assert "Adolf &amp; Co <a" in text and "Co 1, 2" not in text  # экранирование HTML, дома в пост не идут
    assert "map.html?d=2026-11-29" in text and text.rstrip().endswith("#шпера")
    assert build_day_message(day, [], coords, None).startswith("✅ 29 November 2026 выходной.")


def test_expand_street_and_waypoints():
    from sperrmuell.routing import address_query, expand_street, waypoint

    assert expand_street("Gaußstr") == "Gaußstraße"
    assert expand_street("Albert-Einstein-Str") == "Albert-Einstein-Straße"
    assert expand_street("Breslauer Str.") == "Breslauer Straße"
    assert expand_street("Am Waldschlößchen") == "Am Waldschlößchen"
    assert expand_street("Bürgerallee") == "Bürgerallee"
    assert expand_street("Brüderstr") == "Brüderstraße"  # NFD -> NFC
    assert address_query("Gaußstr", "Wuppertal") == "Gaußstraße, Wuppertal"
    assert waypoint("A", {"A": [51.2, 7.1]}, "Wuppertal") == "51.2,7.1"
    assert waypoint("Amboßstr", {}, "Wuppertal") == "Amboßstraße, Wuppertal"
