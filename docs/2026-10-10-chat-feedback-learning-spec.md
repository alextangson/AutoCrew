# 对话里的改稿意见也能被吸取 — 规格（创始人 10-10 已认）

## 为什么

新写稿路径（`autocrew_draft` + `skills/write-script`）第 5 步「改」里，创始人在对话里提意见、AI 改完 `save`，这一版记为 AI 写入，口味学习只学创始人亲手改的，所以对话意见一条也没进档案；他的原话也没存。下一篇 `start` 只带档案生效规则，意见就丢了。

## 创始人定的四件事

1. 写作规则允许在对话里批准（打破「只有工作台能批」的旧约束），每次批准记原话、会话、请求编号，事后可查。
2. 改稿时只记不问；说「定了」时一次列出这篇攒下的待批规则问他。
3. 规则由 AI 概括成通用写法，创始人原话当出处。
4. 生效规则总数上限 12 条；到上限后新规则只能替换某条旧规则才能批准。

## 设计

### A. 记下：`autocrew_draft save` 加可选参数 `feedback`

```json
{ "feedback": {
    "founder_words": "创始人这次的原话，逐字",
    "lessons": [
      { "rule": "概括后的通用规则（≤200 字）", "scope": "voice_core" | "platform:douyin",
        "relation": "new" | "duplicate" | "conflict", "relates_to": "<已有规则 id，duplicate/conflict 必填>" }
    ] } }
```

- 参数按仓库约定归一：对象/数组直接用，字符串先解析（修引号重试），真解析不了才拒，`bad_param` 说清哪里错。`lessons` 缺省或空 = 这条意见只管这篇。
- 只有已经有至少一版正文时才收 `feedback`（第一版是按立意写的，没有意见可记）；否则 `bad_param`。
- 先照常存这一版；存成功后：
  - 稿件上追加 `draftPath.feedback[]`：`{ version: 新版本号, founder_words, at, lessons: [{ rule_id?, outcome }] }`。
  - 每条 lesson：
    - `new` → `addWritingRule({ rule, scope, source: "user_explicit", confidence: 1, evidence: ["稿件 <id> 第 N 版 创始人原话：<原话>"] }, { promote: false })`，新规则另记 `origin: { content_id, version }`。
    - `conflict` → 同上，并在待批规则上记 `conflictsWith: relates_to`。
    - `duplicate` → 不新建；把原话作为出处追加到 `relates_to` 那条规则（新函数，只加 evidence，不动 status/revision）；`relates_to` 不存在或已否决就按 `new` 处理并在回执里说明。
  - 回执加 `lessons: [{ rule, outcome: created_pending | already_exists | blocked_by_tombstone | evidence_added, rule_id? }]`。
- 档案写失败：这一版已存，不回滚；回执带 `lessons_error`（原始错误），技能要求如实告诉创始人。不静默。
- 重复提交：同一个 `base_version` 的第二次 save 本来就会 `version_conflict`，不会重复建规则；不另做去重。

### B. `start` 给 AI 判断用的材料

`context.profile` 在现有 `rules`（字符串数组，保持不变）之外加：
- `rules_detail: [{ id, scope, rule }]` — 当前平台生效的规则，带 id 供 `relates_to` 用；
- `pending_rules: [{ id, scope, rule }]`；
- `rejected_rules: [string]` — 最近 30 条否决过的规则原文，防止换个说法再提；
- `active_rule_count` 与 `rule_cap: 12`。

### C. 批准：对话里定

- 收件箱（`inbox-read.ts` otherItems）里待批写作规则从 `type: "other"` 改为新类型 `writing_rule`：有 `origin` 的带 `content_id`，否则为 null；`detail` 带规则原文、scope、出处原话、冲突规则原文（若有）。
- `CHAT_ACTIONS.writing_rule = ["approve", "reject", "replace"]`（沿用现有 decision 枚举里的同义词，没有就加）；`replace` 需要 `target_rule_id`：一次档案写入里「新规则生效 + 旧规则停用」，旧规则 `disabledReason` 写「被 <新 id> 替换」。
- 放开 `writing_rule` 类型的 `content_id` 必填（`view.ts`、`present.ts`、`decide.ts` 的 locate）。
- 决定落到 `decideWritingRule`：eventId 由 request_id 派生，沿用其 revision 校验、幂等、否决留墓碑；provenance 记 `source: "chat"`、`founder_words`、`requested_by`、`request_id`（和其他对话审批一样）。
- `founder_words` 只是「你定 / 你看着办 / 都行」这类授权式回答时，对 `writing_rule` 拒绝：`founder_words_not_approval`，提示要创始人明确说要哪条。
- 上限：批准（非替换）后生效规则总数会超过 12 → 拒绝 `rule_cap_reached`，回执列出现有生效规则，提示用 `replace`。工作台 `/api/rules/decision` 同样受上限约束，`Calibration.tsx` 把这个错误显示成人话。
- 网页和对话同时批：以先到的为准；后到的拿到 revision 冲突 / 已处理，回执说「这条已在别处处理过」，不重复生效。
- 更新 `writing-rules.ts` 与 `rule-approval.ts` 顶部关于「只有工作台能批」的注释，改成：模型可达入口只产出待批；生效只经工作台会话或带创始人原话的对话决定。

### D. 定稿时一次问完

- `prepare_final` 回执加 `pending_lessons`：`origin.content_id` 是这篇、仍是待批的规则，每条带编号、规则、原话、冲突规则原文。
- 技能第 6 步：出清单时把 `pending_lessons` 编号列给创始人（冲突的两条并排），附 `active_rule_count / 12`；他回「1、3 要，2 不要，4 替换第 X 条」后逐条 `autocrew_review_inbox decide`。他没回就不管，规则留在「等你拍板」里。

### E. 技能 `skills/write-script/SKILL.md`

- 第 5 步：创始人每次提修改，改完 `save` 时都带 `feedback.founder_words`（逐字）。判断这条意见是只管这篇还是能推广：能推广的概括成一条通用规则（不照抄只针对这篇的话），先对照 `rules_detail` / `pending_rules` / `rejected_rules` 判 new / duplicate / conflict；否决过的意思不再提。改稿过程中不问创始人「以后都这样吗」。
- 第 6 步：按 D 列待批规则。
- 回执里有 `lessons_error` 就如实告诉创始人。

## 边界（= 验收清单）

1. 只针对这篇的意见 → 只记 `draftPath.feedback`，不建规则。
2. 和已有生效规则意思重复 → 原话追加为那条规则的出处，不新建；定稿时告诉创始人「这条已有，说明它没管住」。
3. 和已有规则矛盾 → 待批规则带 `conflictsWith`，定稿时并排给他，选替换 / 都留 / 不要。
4. 否决过的 → `rejected_rules` 交给 AI；一字不差的照旧被墓碑拦，回执 `blocked_by_tombstone`。
5. 「你定」类回答 → 对写作规则不算批准。
6. 同一批准发两次 / 网页和对话同时批 → 只生效一次，后到的说明已处理。
7. AI 误把一次性意见当长期规则 → 创始人否决，留墓碑。
8. 生效规则到 12 → 只能替换；网页批准也受限并显示原因。
9. 档案写失败 → 版本已存，回执带原始错误，不静默。
10. 参数是字符串化 JSON / 引号坏了 → 能修就修，修不了才拒，不把非数组当空数组。
11. 不带 `feedback` 的 save、旧收件箱里其他类型、工作台校准页原有流程 → 行为不变。

## 不做

- 补录过去对话里的旧意见。
- 旧写稿路径（workflow / writer / editorial feedback）不改。
- 规则的语义相似度检测：重复/冲突由 AI 判断，代码只按 id 执行。
