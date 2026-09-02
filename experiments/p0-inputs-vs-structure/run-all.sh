#!/bin/bash
# 一个选题一条链，12 格顺序跑。幂等：已有 draft.md 的格跳过。用法：run-all.sh <topicId>
# 端点会抖：每格失败后等 3 分钟重试，最多 4 次；开跑前先等 RELAY_PROBE 能连通（默认 api.deepseek.com，用 Claude 中转时改成它）。
RELAY_PROBE=${RELAY_PROBE:-https://api.deepseek.com/}
T=$1; ROOT=$(cd "$(dirname "$0")" && pwd); LOG=$ROOT/runs/$T.log
relay_up() { [ "$(curl -sS -m 8 -o /dev/null -w '%{http_code}' $RELAY_PROBE 2>/dev/null)" != "000" ]; }
for rep in 1 2; do for r in brief full; do for c in direct writer pipeline; do
  [ -f "$ROOT/runs/$T/$c-$r-rep$rep/draft.md" ] && { echo "=== skip $c $r rep$rep (exists)" >> "$LOG"; continue; }
  for attempt in 1 2 3 4; do
    until relay_up; do echo "... $(date +%H:%M:%S) relay down, waiting" >> "$LOG"; sleep 120; done
    echo "=== $(date +%H:%M:%S) $T $c $r rep$rep attempt$attempt" >> "$LOG"
    if npx tsx $ROOT/run-cell.ts --topic $T --cell $c --research $r --rep $rep >> "$LOG" 2>&1; then break; fi
    echo "!!! FAILED $c $r rep$rep attempt$attempt" >> "$LOG"; sleep 180
  done
done; done; done
echo "=== DONE $(date +%H:%M:%S)" >> "$LOG"
