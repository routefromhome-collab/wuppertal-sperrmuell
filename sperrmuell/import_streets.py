"""Список улиц из AWG-выгрузки 2.xlsx -> web/data/streets.json [{name, district}].

Имя = STRNAME без хвостовой точки (как искал старый парсер: «Achenbachstr.» -> «Achenbachstr»).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from openpyxl import load_workbook


def main(src: str = "data/source/2.xlsx", out: str = "web/data/streets.json") -> int:
    ws = load_workbook(src, read_only=True).active
    rows = ws.iter_rows(values_only=True)
    header = [str(h) for h in next(rows)]
    i_name, i_dist = header.index("STRNAME"), header.index("STADTBEZIRK")
    seen: dict[str, str] = {}
    for r in rows:
        if not r[i_name]:
            continue
        name = str(r[i_name]).strip().rstrip(".").strip()
        seen.setdefault(name, str(r[i_dist] or "").strip())
    data = [{"name": n, "district": d} for n, d in sorted(seen.items(), key=lambda kv: kv[0].casefold())]
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(data)} улиц -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
