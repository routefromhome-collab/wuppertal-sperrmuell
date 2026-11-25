// Поиск ближайших улиц/домов. Чистые функции без DOM.
import { haversineKm } from "./routing.js";
import { stopPoints } from "./schedule.js";

export const FAR_AWAY_KM = 30; // дальше этого расстояния от ближайшей точки пользователь, скорее всего, не в Wuppertal

const isLatLon = (p) =>
  Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;

/**
 * Для каждой улицы берёт её ближайшую к `pos` точку (дом или точку улицы) и сортирует улицы по расстоянию.
 * Улицы без точки на карте в результат не попадают.
 * @returns {{stop: object, point: {ll: number[], label: string, houses: string[]}, km: number}[]}
 */
export function rankStops(pos, stops, coords) {
  if (!isLatLon(pos)) return [];
  const ranked = [];
  for (const stop of stops) {
    let best = null;
    for (const point of stopPoints(stop, coords)) {
      if (!isLatLon(point.ll)) continue;
      const km = haversineKm(pos, point.ll);
      if (!best || km < best.km) best = { stop, point, km };
    }
    if (best) ranked.push(best);
  }
  // при равенстве расстояния порядок стабилен по имени
  return ranked.sort((a, b) => a.km - b.km || a.stop.name.localeCompare(b.stop.name, "de"));
}
