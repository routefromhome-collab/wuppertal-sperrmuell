// Отправка в Telegram Bot API. Токен нигде не логируется и не попадает в ответы.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {Promise<{ok: true} | {ok: false, status: number, description: string}>} */
export async function sendMessage(fetchFn, token, chatId, text, { html = true, maxRetryWaitSec = 15 } = {}) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (html) body.parse_mode = "HTML";
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      await sleep(500 * (attempt + 1));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) return { ok: true };
    if (res.status === 429) {
      const wait = Number(data?.parameters?.retry_after ?? 5);
      if (wait > maxRetryWaitSec) return { ok: false, status: 429, description: `flood wait ${wait}s` };
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (res.status < 500) return { ok: false, status: res.status, description: String(data.description ?? "error") };
    await sleep(500 * (attempt + 1));
  }
  return { ok: false, status: 502, description: "telegram unreachable" };
}
