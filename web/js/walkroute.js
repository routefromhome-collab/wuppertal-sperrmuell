// Пеший маршрут от пользователя до ближайшей точки: рисуется линией на карте.
// Источник: публичный сервер OSM (FOSSGIS, профиль foot, CORS открыт). Если он недоступен, остаётся пунктир по прямой.

const ENDPOINT = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";

/** Разбор ответа OSRM -> {line: [[lat, lon], ...], km, minutes} или null. Чистая функция, покрыта тестом. */
export function parseOsrm(json) {
  const r = json?.code === "Ok" ? json.routes?.[0] : null;
  const coords = r?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2 || !Number.isFinite(r.distance)) return null;
  const line = coords.map(([lon, lat]) => [lat, lon]);
  if (line.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) return null;
  return { line, km: r.distance / 1000, minutes: Number.isFinite(r.duration) ? Math.max(1, Math.round(r.duration / 60)) : null };
}

export async function fetchWalkRoute(from, to, { timeoutMs = 7000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${ENDPOINT}/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&alternatives=false`;
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return parseOsrm(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Рисует маршрут в слое layer: сразу пунктир по прямой, потом (если сервер ответил) настоящий путь.
 * Возвращает промис с результатом {km, minutes} или null; устаревшие вызовы (token) ничего не рисуют.
 */
export async function drawWalkRoute({ layer, from, to, isCurrent, accent = "#1a73e8" }) {
  layer.clearLayers();
  L.polyline([from, to], { color: accent, weight: 4, opacity: 0.8, dashArray: "6 8" }).addTo(layer);
  const route = await fetchWalkRoute(from, to);
  if (!route || !isCurrent()) return null;
  layer.clearLayers();
  L.polyline(route.line, { color: "#fff", weight: 9, opacity: 0.9 }).addTo(layer); // белая подложка
  L.polyline(route.line, { color: accent, weight: 5, opacity: 0.95 }).addTo(layer);
  return route;
}
