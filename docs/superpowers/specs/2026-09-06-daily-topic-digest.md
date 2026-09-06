# 每日选题摘要：雷达命中推到 Telegram，回一个数字起调研

> 日期：2026-09-06
> 状态：定稿即建（半天体量，不走 codex 评审）
> 创始人原话：「那我怎么收到每日的选题推送？」→「做 每日选题摘要发到 Telegram」

## 0. 一句话

雷达每 30 分钟往「今日」页填候选，但只有打开工作台才看得到。加一条主动推送：每天固定时间把当天雷达入库、最贴定位的几条发到创始人的 Telegram，每条一行「为什么值得做」，回一个数字就起深调研。

## 1. 现状（代码出处）

- 雷达入库把命中项**直接存成选题**：`intakeRadarTopics`（`src/modules/radar/radar-intake.ts:169-176`）→ `saveTopic({ title, source: "radar:<源>", reason, link })`；「今日」页的灵感摘要就是这些选题按最新入库取前几条（`src/desktop/dashboard-summary.ts:253`）。三天没选用会进回收站（`topic-expiry.ts`）。
- Telegram 通道已具备：`callTelegram` / `sendTelegramReceipt`（`src/modules/inbox/telegram-api.ts:127, 179`，带代理、重试、确定性错误不空转）；轮询器 `telegram-poller.ts` 把入站消息分成 `text | command | media`；白名单 `allowedUserIds`（DM 的 chat_id = user id）。生产已配好 bot、白名单 1 人、代理 `127.0.0.1:1082`。
- 深调研起手：`triggerDeepResearch(topicId)`（`src/desktop/research-runtime.ts:220`），需要搜索 Key（否则 `SEARCH_NOT_CONFIGURED`）。
- 没有任何主动推送；`inbox:status` 有 poller 心跳与 `lastError`，无时间戳（P2b 留的坑）。

## 2. 设计

### 2.1 选什么

- 候选 = `source` 以 `radar:` 开头、状态仍是初始（未选用、未进回收站）、**上一份摘要之后**入库的选题；第一次发取最近 24 小时。
- 排序沿用入库顺序（入库时已按相关度过门），取前 5 条。标题截 60 字，`reason` 截 80 字。
- 一条都没有 → 仍发一行「今天雷达没有新的命中定位的选题（扫了 N 个源）」，一天一次。沉默会让人分不清「没选题」和「没发出去」。

### 2.2 发什么（纯文本，不用 Markdown 解析模式，省掉转义坑）

```
AutoCrew 今日选题 · 9 月 7 日

1. DeepSeek Harness 开源实战：Agent 运行时万物皆插件架构拆解
   命中「Agent 落地」· 36氪 · 3h 前
   https://…
2. …

回复数字起深调研（1–5）；回 0 = 今天都不做。
```
总长 ≤ 3500 字（Telegram 上限 4096）。

### 2.3 什么时候发

- 进程内调度，与雷达同款（`radar-cycle.ts` 的 setInterval 模式，不是系统 cron）：每分钟看一眼「已启用 && 本地时间 ≥ 设定小时 && 今天还没发」→ 发。
- **按本地日期幂等**：`<dataDir>/digest-state.json` 记 `lastSentDate`、`lastDigest{date, items[{n, topicId, title}]}`、`attemptsToday`、`lastError`、`lastErrorAt`。
- 服务当天晚起（设定 9 点，14 点才 `npm start`）→ 启动后补发当天那份；昨天没发的不补。
- 发送失败 → 10 分钟后重试，一天最多 3 次；每次失败都记 `lastError/lastErrorAt`，进 events；不静默。

### 2.4 回复怎么接

- 轮询器收到白名单用户的**纯数字**文本（`/^\d{1,2}$/`）且存在 `lastDigest`：
  - `0` → 回「好，今天不动」。
  - `1..N` → `triggerDeepResearch(topicId)`；回「已起深调研：《标题》。立意卡出来后到工作台看，或再回同一个数字看进度」。同一数字再回 → 回当前 job 状态（queued/running/succeeded/failed）。
  - 超范围 → 回「清单里只有 1–N」。
  - 搜索没配 → 回 `SEARCH_NOT_CONFIGURED` 那句人话，不起 job。
- 回复永远对**最新一份**摘要生效；那份不是今天的 → 回复里带上它的日期「（这是 9 月 6 日的清单）」。
- 纯数字消息不进灵感入账（否则每次回数字都多一条「灵感：3」）。

### 2.5 设置与可见

- `InboxSettings` 加 `digestEnabled?: boolean`（默认 true）、`digestHour?: number`（0–23，默认 9）；`inbox:settings_set` 接 `digest_enabled` / `digest_hour`。
- `inbox:status` 加 `digest: { enabled, hour, nextAt, lastSentAt, lastError, lastErrorAt, attemptsToday }`；顺手给 `poller` 补 `lastErrorAt`（P2b 留的坑）。
- 新 IPC `inbox:digest_send_now`：立刻发一份（用于测试与「今天再来一份」）；幂等规则对它不生效，但 `lastDigest` 会被替换（回复按新清单算）。
- 「接入更多 · Telegram」卡加一段「每日选题摘要」：开关、小时下拉、上次发送 / 上次失败、「现在发一份」按钮。bot 没配时这段灰显并说「先配 bot」。

## 3. 边界（product-sense 五问，即验收清单）

**状态**：bot 未配置 → 调度不启动，卡上说明；候选为空 → 发空摘要一行；当天已发 → 不重发；服务晚起 → 补当天；昨天漏发 → 不补。
**最坏输入**：标题/理由超长 → 截断；5 条合计超长 → 再截到 3500；用户回「12」超范围 → 明说范围；回「3 」带空格 → trim 后仍算数字；两条数字连发 → 各自处理，第二条若同一选题回状态。
**防呆**：「现在发一份」连点两次 → 第二次返回「刚发过（N 秒前）」；改小时后当天已发不再发第二份；卸掉 bot token → 调度停。
**失败可见**：发送失败进 `lastError/lastErrorAt` + events，卡上显示；`triggerDeepResearch` 失败原话回给 Telegram。
**不做**：多收件人、周报、调研完成后的回推（下一步再看）、通过 Telegram 改设置。

## 4. 验收

- 单测：选候选（来源过滤、时间窗、排序、截断）、渲染长度、幂等/补发/不补昨天、失败计数与记录、回复映射（0 / 范围内 / 超范围 / 旧清单日期 / 搜索未配）、设置往返。
- 真机：生产 bot 真发一份到创始人 Telegram（创始人明确要求）；卡上出现上次发送时间；回一个数字，工作台该选题起深调研。

## 5. 落地记录（2026-09-06，提交 073b292）

301 个测试文件全绿。生产真机：重启后调度器按「当天晚起补发」规则在首个 tick 自动发出当天摘要（2 条雷达候选：GPT-6 Astra 两条），events 记「每日选题摘要已发出：2 条候选」，`inbox:status.digest` 显示 `lastSentAt`、`attemptsToday: 1`、`nextAt` 为次日 09:00 本地时间，无错误。回复数字起调研这一段只能由创始人在 Telegram 里验。工作台的「每日选题摘要」段在隔离环境渲染正常；生产的浏览器会话由创始人自己的浏览器持有，本轮未在生产页面点按钮。
