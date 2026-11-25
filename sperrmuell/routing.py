"""Порядок обхода точек (nearest neighbour + 2-opt) и ссылки Google Maps.

Логика перенесена из старого main.py. Исправлено: 2-opt теперь корректно работает
с открытым маршрутом (старая версия замыкала индекс по кругу), а следующий кусок
маршрута начинается с последней точки предыдущего, чтобы части стыковались.
Та же логика есть в web/js/routing.js: при изменении правьте оба файла.
"""

from __future__ import annotations

import math
import re
import unicodedata
from urllib.parse import quote

GOOGLE_CHUNK = 20  # максимум точек в одной ссылке
Coord = tuple[float, float]


def expand_street(name: str) -> str:
    """Gaußstr -> Gaußstraße, Albert-Einstein-Str -> Albert-Einstein-Straße (Google плохо находит сокращения)."""
    name = unicodedata.normalize("NFC", " ".join(str(name).split()))
    name = re.sub(r"(^|[\s-])Str\.?$", r"\1Straße", name)
    return re.sub(r"([A-Za-zÄÖÜäöüß])str\.?$", r"\1straße", name)


def address_query(name: str, city: str) -> str:
    return f"{expand_street(name)}, {city}"


def waypoint(name: str, coords: dict, city: str) -> str:
    """Координаты, если есть (находятся всегда), иначе полный адрес текстом."""
    ll = coords.get(name)
    if ll and all(isinstance(v, (int, float)) and math.isfinite(v) for v in ll):
        return f"{ll[0]},{ll[1]}"
    return address_query(name, city)


def haversine_km(a: Coord, b: Coord) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def distance_matrix(points: list[Coord]) -> list[list[float]]:
    n = len(points)
    m = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            m[i][j] = m[j][i] = haversine_km(points[i], points[j])
    return m


def nearest_neighbor(dist: list[list[float]], start: int = 0) -> list[int]:
    n = len(dist)
    if n == 0:
        return []
    visited = [False] * n
    route = [start]
    visited[start] = True
    for _ in range(n - 1):
        last = route[-1]
        best, best_d = -1, math.inf
        for j in range(n):
            if not visited[j] and dist[last][j] < best_d:
                best, best_d = j, dist[last][j]
        route.append(best)
        visited[best] = True
    return route


def two_opt(route: list[int], dist: list[list[float]], eps: float = 1e-9) -> list[int]:
    """2-opt для открытого пути; первая точка остаётся на месте."""
    route = route[:]
    n = len(route)
    if n < 4:
        return route
    improved = True
    while improved:
        improved = False
        for i in range(1, n - 1):
            for j in range(i + 1, n):
                a, b, c = route[i - 1], route[i], route[j]
                d = route[j + 1] if j + 1 < n else None
                before = dist[a][b] + (dist[c][d] if d is not None else 0.0)
                after = dist[a][c] + (dist[b][d] if d is not None else 0.0)
                if after < before - eps:
                    route[i : j + 1] = reversed(route[i : j + 1])
                    improved = True
    return route


def order_points(points: list[Coord], start: Coord | None = None) -> list[int]:
    """Индексы `points` в порядке обхода. Если задан `start`, путь строится от него."""
    if not points:
        return []
    pts = ([start] if start else []) + list(points)
    dist = distance_matrix(pts)
    route = two_opt(nearest_neighbor(dist, 0), dist)
    shift = 1 if start else 0
    return [i - shift for i in route if i - shift >= 0]


_COORD = re.compile(r"^-?\d+(\.\d+)?,-?\d+(\.\d+)?$")


def _encode_waypoint(s: str) -> str:
    return s if _COORD.match(s) else quote(s, safe="")


def google_route_links(
    waypoints: list[str], chunk: int = GOOGLE_CHUNK
) -> list[str]:
    """Ссылки https://www.google.com/maps/dir/A/B/C/ по `chunk` точек.

    Следующая ссылка начинается с последней точки предыдущей (стыковка частей).
    """
    links: list[str] = []
    i = 0
    while i < len(waypoints):
        seg = waypoints[i : i + chunk]
        links.append(
            "https://www.google.com/maps/dir/"
            + "/".join(_encode_waypoint(s) for s in seg)
            + "/"
        )
        if i + chunk >= len(waypoints):
            break
        i += chunk - 1
    return links
