// Адреса для Google Maps. В данных AWG улицы сокращены («Gaußstr», «Albert-Einstein-Str»), а Google по такому тексту
// часто не находит улицу (особенно с ß и умляутами), поэтому текстовый запрос пишем полным словом «straße».

/** Gaußstr -> Gaußstraße; Albert-Einstein-Str -> Albert-Einstein-Straße; Breslauer Str. -> Breslauer Straße. */
export function expandStreet(name) {
  return String(name)
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(^|[\s-])Str\.?$/, "$1Straße")
    .replace(/([A-Za-zÄÖÜäöüß])str\.?$/, "$1straße");
}

/** Текст запроса для Google: «Gaußstraße, Wuppertal». */
export const addressQuery = (name, city) => `${expandStreet(name)}, ${city}`;

/** Точка маршрута: координаты, если они есть (находятся всегда), иначе полный адрес текстом. */
export function waypoint(name, coords, city) {
  const ll = coords?.[name];
  if (Array.isArray(ll) && Number.isFinite(ll[0]) && Number.isFinite(ll[1])) return `${ll[0]},${ll[1]}`;
  return addressQuery(name, city);
}
