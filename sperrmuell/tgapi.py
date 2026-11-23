"""Минимальный клиент Telegram Bot API (requests): отправка с обработкой 429 и админ-уведомления."""

from __future__ import annotations

import logging
import os
import time

import requests

log = logging.getLogger(__name__)
CHUNK_MAX = 4000  # лимит Telegram 4096, оставляем запас


def chunk_text(text: str, max_len: int = CHUNK_MAX) -> list[str]:
    chunks = []
    while len(text) > max_len:
        cut = text.rfind("\n", 0, max_len)
        if cut <= 0:
            cut = max_len
        chunks.append(text[:cut])
        text = text[cut:].lstrip("\n")
    if text:
        chunks.append(text)
    return chunks


def send_message(token: str, chat_id: str, text: str, *, html: bool = True, attempts: int = 6) -> bool:
    payload = {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
    if html:
        payload["parse_mode"] = "HTML"
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    for i in range(attempts):
        try:
            r = requests.post(url, json=payload, timeout=20)
            if r.status_code == 429:
                wait = r.json().get("parameters", {}).get("retry_after", 5) + 1
                log.warning("Telegram 429, ждём %ss", wait)
                time.sleep(wait)
                continue
            if r.ok:
                return True
            log.error("Telegram %s: %s", r.status_code, r.text[:200])  # токена в тексте нет
            if 400 <= r.status_code < 500:
                return False  # ретраи не помогут
        except requests.RequestException as e:
            log.warning("Telegram: %s", type(e).__name__)
        time.sleep(min(2**i, 30))
    return False


def notify_admin(text: str) -> bool:
    """Технические сообщения в отдельный админ-чат (TELEGRAM_ADMIN_CHAT_ID)."""
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_ADMIN_CHAT_ID")
    if not token or not chat:
        log.info("Админ-чат не настроен, уведомление пропущено: %s", text)
        return False
    return send_message(token, chat, text, html=False)
