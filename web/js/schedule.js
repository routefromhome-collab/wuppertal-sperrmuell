// Выборка улиц из schedule.json. Зеркало sperrmuell/schedule.py.
import { putOutToPickup } from "./dates.js";

const NUM = /^(\d+)(.*)$/;

export function naturalCompare(a, b) {
  const ma = NUM.exec(a);
  const mb = NUM.exec(b);
  const ka = ma ? [Number(ma[1]), ma[2]] : [Infinity, a];
  const kb = mb ? [Number(mb[1]), mb[2]] : [Infinity, b];
  return ka[0] - kb[0] || ka[1].localeCompare(kb[1]) || 0;
}

/** Улицы, где в день `putOutIso` выставляют Sperrmüll (вывоз AWG на следующий день). */
export function streetsForPutOut(schedule, putOutIso) {
  const target = putOutToPickup(putOutIso);
  const stops = [];
  for (const [name, entry] of Object.entries(schedule?.streets ?? {})) {
    if ((entry.dates ?? []).includes(target)) {
      stops.push({ name, houses: [] });
      continue;
    }
    const houses = Object.entries(entry.houses ?? {})
      .filter(([, dates]) => dates.includes(target))
      .map(([house]) => house)
      .sort(naturalCompare);
    if (houses.length) stops.push({ name, houses });
  }
  return stops.sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
}

/** Самая поздняя дата вывоза в данных: за ней «нет в списке» != «выходной». */
export function lastPickupDate(schedule) {
  let max = null;
  for (const entry of Object.values(schedule?.streets ?? {})) {
    const all = [...(entry.dates ?? []), ...Object.values(entry.houses ?? {}).flat()];
    for (const d of all) if (max === null || d > max) max = d;
  }
  return max;
}

export function isStale(schedule, nowMs = Date.now(), maxDays = 45) {
  if (!schedule?.generated_at) return false;
  return nowMs - Date.parse(schedule.generated_at) > maxDays * 86_400_000;
}
