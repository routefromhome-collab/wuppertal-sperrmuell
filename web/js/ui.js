// Общие мелочи интерфейса для app (Mini App) и map.html (публичная карта дня).
import { openExternal } from "./tg.js";

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const plural = (n, [one, few, many]) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};
export const STREETS = ["улица", "улицы", "улиц"];

export const googlePoint = ([lat, lon]) => `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;

/** Ссылка открывается средствами Telegram (в Mini App) либо новой вкладкой (в браузере). */
export function externalLink(a) {
  a.target = "_blank";
  a.rel = "noopener";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    openExternal(a.href);
  });
  return a;
}

export function formatDistance(km) {
  if (km >= 1) return `${km.toFixed(1).replace(".", ",")} км`;
  return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} м`;
}

/** Время пешком: прямая линия умножается на 1.3 (улицы редко идут по прямой), скорость 5 км/ч. */
export const walkMinutes = (km) => Math.max(1, Math.round(((km * 1.3) / 5) * 60));
