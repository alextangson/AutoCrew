#!/usr/bin/env python3
"""平台导出 xlsx → 飞轮可导入 CSV。

三大后台的按作品导出实际是 xlsx（不是 CSV），且常带说明横幅行和中文日期。
本脚本做三件事：取指定表头行、剥掉之前的横幅、把"2026年03月31日15时09分32秒"
归一成 "2026-03-31 15:09:32"。

用法：
  python3 scripts/xlsx-to-csv.py 输入.xlsx 输出.csv [表头行号，默认自动探测]

依赖：pandas + openpyxl（pip3 install openpyxl --break-system-packages）
"""
import csv
import re
import sys
import warnings

import pandas as pd

warnings.filterwarnings("ignore")

CN_DT = re.compile(r"(\d{4})年(\d{1,2})月(\d{1,2})日(?:(\d{1,2})时(\d{1,2})分(\d{1,2})秒)?")


def fix_cell(v):
    s = "" if str(v) == "nan" else str(v)
    m = CN_DT.fullmatch(s.strip())
    if not m:
        return s
    y, mo, d, h, mi, sec = m.groups()
    date = f"{y}-{int(mo):02d}-{int(d):02d}"
    if h is None:
        return date
    return f"{date} {int(h):02d}:{int(mi):02d}:{int(sec):02d}"


def detect_header_row(raw: pd.DataFrame) -> int:
    """表头行 = 第一行"非空格子多且互不相同"的行（横幅行通常是同一句话重复或大半为空）。"""
    for i in range(min(5, len(raw))):
        cells = [str(c) for c in raw.iloc[i] if str(c) != "nan"]
        if len(cells) >= 3 and len(set(cells)) == len(cells):
            return i
    return 0


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    raw = pd.read_excel(src, header=None)
    header_row = int(sys.argv[3]) if len(sys.argv) > 3 else detect_header_row(raw)
    headers = [str(h).strip() for h in raw.iloc[header_row]]
    with open(dst, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(headers)
        for r in raw.iloc[header_row + 1 :].values.tolist():
            w.writerow([fix_cell(v) for v in r])
    print(f"{dst}（{len(raw) - header_row - 1} 行数据，表头行 {header_row}）")


if __name__ == "__main__":
    main()
