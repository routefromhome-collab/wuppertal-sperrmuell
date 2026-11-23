// Порядок обхода (nearest neighbour + 2-opt) и ссылки Google Maps. Зеркало sperrmuell/routing.py.

export const GOOGLE_CHUNK = 20; // максимум точек в одной ссылке

export function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

export function distanceMatrix(points) {
  const n = points.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) m[i][j] = m[j][i] = haversineKm(points[i], points[j]);
  return m;
}

export function nearestNeighbor(dist, start = 0) {
  const n = dist.length;
  if (!n) return [];
  const seen = new Array(n).fill(false);
  const route = [start];
  seen[start] = true;
  for (let k = 1; k < n; k++) {
    const last = route[route.length - 1];
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) if (!seen[j] && dist[last][j] < bestD) [best, bestD] = [j, dist[last][j]];
    route.push(best);
    seen[best] = true;
  }
  return route;
}

/** 2-opt для открытого пути; первая точка остаётся на месте. */
export function twoOpt(route, dist, eps = 1e-9) {
  const r = route.slice();
  const n = r.length;
  if (n < 4) return r;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const [a, b, c] = [r[i - 1], r[i], r[j]];
        const d = j + 1 < n ? r[j + 1] : null;
        const before = dist[a][b] + (d !== null ? dist[c][d] : 0);
        const after = dist[a][c] + (d !== null ? dist[b][d] : 0);
        if (after < before - eps) {
          const seg = r.slice(i, j + 1).reverse();
          r.splice(i, seg.length, ...seg);
          improved = true;
        }
      }
    }
  }
  return r;
}

/** Индексы `points` в порядке обхода; при заданном `start` путь строится от него. */
export function orderPoints(points, start = null) {
  if (!points.length) return [];
  const pts = start ? [start, ...points] : points;
  const dist = distanceMatrix(pts);
  const shift = start ? 1 : 0;
  return twoOpt(nearestNeighbor(dist, 0), dist)
    .map((i) => i - shift)
    .filter((i) => i >= 0);
}

/** Ссылки maps/dir/A/B/C/ по `chunk` точек; следующая часть начинается с последней точки предыдущей. */
export function googleRouteLinks(waypoints, chunk = GOOGLE_CHUNK) {
  const links = [];
  for (let i = 0; i < waypoints.length; i += chunk - 1) {
    const seg = waypoints.slice(i, i + chunk);
    links.push({
      url: "https://www.google.com/maps/dir/" + seg.map((s) => encodeURIComponent(s)).join("/") + "/",
      count: seg.length,
    });
    if (i + chunk >= waypoints.length) break;
  }
  return links;
}

/**
 * Маршрут по улицам дня. Точки с координатами идут по TSP, без координат — в конец по алфавиту.
 * start = [lat, lon] | null (позиция пользователя).
 */
export function planRoute(stops, coords, { city = "Wuppertal", start = null } = {}) {
  const withXY = stops.filter((s) => coords[s.name]);
  const without = stops.filter((s) => !coords[s.name]);
  const order = orderPoints(withXY.map((s) => coords[s.name]), start);
  const names = [...order.map((i) => withXY[i].name), ...without.map((s) => s.name)];
  const waypoints = names.map((n) => `${n}, ${city}`);
  if (start) waypoints.unshift(`${start[0]},${start[1]}`);
  return { names, links: googleRouteLinks(waypoints) };
}
