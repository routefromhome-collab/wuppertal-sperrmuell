// Админы из приложения: владельцы заданы секретом ADMIN_IDS, остальные хранятся в KV (ключ "admins").
// Любой админ может добавлять и удалять добавленных админов; владельцев из ADMIN_IDS удалить нельзя.
import { adminIds } from "./auth.js";
import { getProfile, profileOf } from "./telegram.js";

const KEY = "admins";
const PROFILES = "profiles"; // id -> {username?, name?}: чтобы в списке показывать ник, а не число
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

async function loadProfiles(env) {
  if (!env.STATE) return {};
  try {
    const raw = await env.STATE.get(PROFILES);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

const same = (a, b) => a?.username === b?.username && a?.name === b?.name;

/** Запоминает ник/имя пользователя, когда он сам пользуется приложением (пишем в KV, только если что-то изменилось). */
export async function recordProfile(env, user) {
  if (!env.STATE) return;
  const p = profileOf(user);
  if (!p) return;
  const profiles = await loadProfiles(env);
  if (same(profiles[String(user.id)], p)) return;
  profiles[String(user.id)] = p;
  await env.STATE.put(PROFILES, JSON.stringify(profiles));
}

/** Для тех, чьего профиля нет, пробуем спросить Telegram (получится, если человек уже писал боту). */
async function fillMissing(env, deps, ids, profiles) {
  const missing = ids.filter((id) => !profiles[id]).slice(0, 10);
  if (!missing.length || !env.BOT_TOKEN || !deps?.fetch) return profiles;
  let changed = false;
  await Promise.all(
    missing.map(async (id) => {
      const p = await getProfile(deps.fetch, env.BOT_TOKEN, id);
      if (p) {
        profiles[id] = p;
        changed = true;
      }
    }),
  );
  if (changed && env.STATE) await env.STATE.put(PROFILES, JSON.stringify(profiles));
  return profiles;
}

const label = (id, p) => (p?.username ? `@${p.username}` : p?.name ?? null) ?? null;

export async function listAdmins(env, deps) {
  const extra = await loadExtra(env);
  const owners = [...adminIds(env)];
  const profiles = await fillMissing(env, deps, [...owners, ...Object.keys(extra), ...Object.values(extra).map((v) => v.by)], await loadProfiles(env));
  const nameOf = (id) => label(id, profiles[String(id)]);
  return {
    owners: owners.map((id) => ({ id, label: nameOf(id) })),
    extra: Object.entries(extra).map(([id, v]) => ({ id, label: nameOf(id), by: v.by, byLabel: nameOf(v.by), at: v.at })),
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
