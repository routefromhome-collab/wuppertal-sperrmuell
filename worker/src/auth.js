// Проверка Telegram Mini App initData (HMAC-SHA256 по токену бота) и список админов.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

const enc = new TextEncoder();

async function hmacKey(keyBytes, usages) {
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
}

/**
 * @returns {Promise<{ok: true, user: object, authDate: number} | {ok: false, reason: string}>}
 * reason: "malformed" | "bad_signature" | "expired" | "no_user"
 */
export async function verifyInitData(initData, botToken, { maxAgeSec = 3600, nowMs = Date.now() } = {}) {
  if (typeof initData !== "string" || !initData || initData.length > 4096 || !botToken) {
    return { ok: false, reason: "malformed" };
  }
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const given = hash && hexToBytes(hash);
  if (!given) return { ok: false, reason: "malformed" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = await crypto.subtle.sign("HMAC", await hmacKey(enc.encode("WebAppData"), ["sign"]), enc.encode(botToken));
  // subtle.verify сравнивает подпись за постоянное время
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), given, enc.encode(dataCheckString));
  if (!valid) return { ok: false, reason: "bad_signature" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowMs / 1000 - authDate > maxAgeSec || authDate - nowMs / 1000 > 300) {
    return { ok: false, reason: "expired" };
  }
  let user;
  try {
    user = JSON.parse(params.get("user") ?? "");
  } catch {
    return { ok: false, reason: "no_user" };
  }
  if (!user || typeof user.id !== "number") return { ok: false, reason: "no_user" };
  return { ok: true, user, authDate };
}

export function adminIds(env) {
  return new Set(String(env.ADMIN_IDS ?? "").split(/[\s,]+/).filter(Boolean));
}

export const isAdmin = (env, user) => adminIds(env).has(String(user.id));
