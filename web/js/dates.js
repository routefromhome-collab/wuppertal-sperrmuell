// Даты как ISO-строки YYYY-MM-DD, арифметика через UTC: без сюрпризов летнего времени.
// Правило D-1 (намеренное, не менять): вывоз AWG в день P -> выставляют Sperrmüll в P-1.
// Зеркало sperrmuell/dates.py.

export const PUTOUT_SHIFT_DAYS = 1;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIso(value) {
  const m = ISO.exec(value ?? "");
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** День выставления -> день вывоза AWG (по нему ищем в календаре). */
export const putOutToPickup = (iso) => addDays(iso, PUTOUT_SHIFT_DAYS);
/** День вывоза AWG -> день выставления. */
export const pickupToPutOut = (iso) => addDays(iso, -PUTOUT_SHIFT_DAYS);

/** Окно из `days` дней выставления; введённая дата = день 1. */
export function window7(startIso, days = 7) {
  return Array.from({ length: days }, (_, i) => addDays(startIso, i));
}

/** Сегодняшняя дата в Wuppertal, а не в часовом поясе устройства. */
export function todayBerlin(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(now);
}

const fmt = (opts) => new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", ...opts });
const asDate = (iso) => new Date(`${iso}T00:00:00Z`);

export const formatWeekdayShort = (iso) => fmt({ weekday: "short" }).format(asDate(iso));
export const formatDayNumber = (iso) => String(Number(iso.slice(8, 10)));
export const formatLong = (iso) => fmt({ weekday: "short", day: "numeric", month: "long" }).format(asDate(iso));

export const MONTHS_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

/** 29 November 2026: формат дат в постах канала (как в рабочем main.py). */
export function formatDe(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS_DE[m - 1]} ${y}`;
}
