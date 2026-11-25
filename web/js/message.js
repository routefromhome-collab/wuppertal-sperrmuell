// Текст постов для канала. Чистые функции без DOM: используются и Worker-ом, и тестами.
// Формат повторяет рабочий main.py: заголовок, улицы по алфавиту со ссылкой map, маршруты, ссылка на карту, #шпера.
import { formatDe } from "./dates.js";
import { addressQuery } from "./address.js";
import { planRoute } from "./routing.js";

export const CITY = "Wuppertal";
export const CHUNK_MAX = 4000; // лимит Telegram 4096, оставляем запас

export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** @param {{iso: string, stops: {name: string}[], coords: object, mapUrl?: string}} p */
export function buildDayMessage({ iso, stops, coords, mapUrl }) {
  const title = formatDe(iso);
  if (!stops.length) return `✅ ${title} выходной.\n\n#шпера`;

  const lines = [`🗑 <b>Шпера ${title}:</b>\n`];
  for (const stop of stops) {
    const q = encodeURIComponent(addressQuery(stop.name, CITY));
    lines.push(`${escapeHtml(stop.name)} <a href="https://www.google.com/maps/search/?api=1&amp;query=${q}">map</a>`);
  }
  const { links } = planRoute(stops, coords, { city: CITY });
  links.forEach((l, i) => lines.push(`\n🗺 Маршрут (часть ${i + 1}): <a href="${escapeHtml(l.url)}">map</a>`));

  if (mapUrl) {
    // публичная страница map.html (не Mini App): ссылка работает в любом браузере и ведёт ровно на этот день
    const sep = mapUrl.includes("?") ? "&" : "?";
    lines.push(`\n📍Полная карта на ${title}: <a href="${escapeHtml(`${mapUrl}${sep}d=${iso}`)}">map</a>`);
  }
  lines.push("\n#шпера");
  return lines.join("\n");
}

/** Адрес публичной карты: MAP_URL или map.html рядом с каталогом данных (…/data -> …/map.html). */
export function resolveMapUrl(env) {
  if (env.MAP_URL) return env.MAP_URL;
  const base = String(env.DATA_BASE_URL ?? "").replace(/\/+$/, "").replace(/\/data$/, "");
  return base ? `${base}/map.html` : "";
}

/** Делит текст по переводам строк на части не длиннее max. */
export function chunkText(text, max = CHUNK_MAX) {
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}
