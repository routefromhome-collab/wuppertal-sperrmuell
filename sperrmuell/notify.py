"""python -m sperrmuell.notify "текст": сообщение в админ-чат (для шагов workflow при сбоях)."""

from __future__ import annotations

import sys

from .tgapi import notify_admin

if __name__ == "__main__":
    notify_admin(" ".join(sys.argv[1:]) or "(пустое сообщение)")
