// Админы из приложения: владельцы заданы секретом ADMIN_IDS, остальные хранятся в KV (ключ "admins").
// Любой админ может добавлять и удалять добавленных админов; владельцев из ADMIN_IDS удалить нельзя.
import { adminIds } from "./auth.js";

const KEY = "admins";
export const MAX_EXTRA = 20;
export const validId = (v) => /^\d{5,15}$/.test(String(v));

/** @returns {Promise<Record<string, {by: string, at: number}>>} */
export async function loadExtra(env) {
  if (!env.STATE) return {};
  try {
    const raw = await env.STATE.get(KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (err) {
    console.error("не удалось прочитать список админов:", err);
    return {};
  }
}

export async function isAdminAny(env, user) {
  const id = String(user.id);
  if (adminIds(env).has(id)) return true;
  return Object.hasOwn(await loadExtra(env), id);
}

export async function listAdmins(env) {
  const extra = await loadExtra(env);
  return {
    owners: [...adminIds(env)],
    extra: Object.entries(extra).map(([id, v]) => ({ id, by: v.by, at: v.at })),
    canManage: Boolean(env.STATE),
  };
}

/** @returns {{ok: true, already?: boolean} | {ok: false, error: string, message: string}} */
export async function addAdmin(env, id, by, now) {
  if (!env.STATE) return { ok: false, error: "no_kv", message: "Хранилище STATE (KV) не подключено: см. README, раздел «Админы из приложения»." };
  id = String(id).trim();
  if (!validId(id)) return { ok: false, error: "bad_id", message: "Telegram ID это число из 5-15 цифр." };
  if (adminIds(env).has(id)) return { ok: true, already: true };
  const extra = await loadExtra(env);
  if (Object.hasOwn(extra, id)) return { ok: true, already: true };
  if (Object.keys(extra).length >= MAX_EXTRA) return { ok: false, error: "limit", message: `Не больше ${MAX_EXTRA} добавленных админов.` };
  extra[id] = { by: String(by), at: now };
  await env.STATE.put(KEY, JSON.stringify(extra));
  return { ok: true };
}

export async function removeAdmin(env, id) {
  if (!env.STATE) return { ok: false, error: "no_kv", message: "Хранилище STATE (KV) не подключено." };
  id = String(id).trim();
  if (adminIds(env).has(id)) return { ok: false, error: "owner", message: "Владельца из ADMIN_IDS удалить нельзя: он задан секретом Worker." };
  const extra = await loadExtra(env);
  if (!Object.hasOwn(extra, id)) return { ok: true, already: true };
  delete extra[id];
  await env.STATE.put(KEY, JSON.stringify(extra));
  return { ok: true };
}
