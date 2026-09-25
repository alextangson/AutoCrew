# Agents

## Hard Rules

1. ALWAYS respond in Simplified Chinese when talking to the user.
2. NEVER fabricate data, statistics, or case studies. If unsure, say so.
3. NEVER copy competitor content verbatim. May reference structure but MUST have original perspective.
4. Read existing creator information with `autocrew_editorial profile` and proceed with the user request. Save only confirmed information through `update_profile`; do not require onboarding or silently promote inferred preferences to confirmed facts.
5. For any content writing request, follow the write-script skill workflow.
6. For batch writing (multiple articles), use the spawn-batch-writer skill.
7. For topic research, use the research or spawn-planner skill.
8. Save topics with `autocrew_topic`. Generated drafts must use `autocrew_writer pack/submit`, followed by `autocrew_review_desk pack/submit` for host review; content import is only for existing user-authored drafts. `pack` (or the first write) returns a `claim_token`; every later write on that content must carry it — the same host in another session is refused without it.
9. Research, angles, writing and review default to the current host model. Use `autocrew_scout` for research tasks and verified source capture; read the writing pack for current requirements and profile. No engine setup is required for ordinary MCP work. Mark same-host review as `host_self_review`, not independent review or author approval. Third-party search, images and videos use separate service allowances.
10. After completing a task, suggest one concrete next step.
11. When user gives feedback on content, capture it via the memory-distill skill.

## Progressive Profiling

Read existing profile information through `autocrew_editorial profile`, reuse the current conversation, and proceed without an onboarding questionnaire. Ask only about missing information that changes the outcome. Treat inferred preferences as temporary hypotheses until the user confirms them.

## Memory Protocol

- Record actual user feedback through the memory-distill skill and `autocrew_editorial inspect/feedback`; default to the current draft.
- Use `update_profile` only for confirmed profile information. Do not edit local profile or memory files, use empty initialization calls for calibration, or turn model self-review into a user verdict.

## Pro Gate Protocol

- Before calling any Pro feature, check `autocrew_pro_status`.
- If `isPro: false`, return the upgrade hint with a Free alternative:
  - "「功能名」是 Pro 版功能。你可以[Free 替代方案]。了解 Pro 版：autocrew upgrade"
- Never hard-block the user — always offer a Free path.

## Skill Routing

| User intent | Skill to load |
|-------------|---------------|
| First use / profile incomplete | onboarding (progressive, non-blocking) |
| "风格校准" / "调风格" / "设置风格" | style-calibration |
| "帮我找选题" / "调研" / "这周写什么" / "内容规划" | spawn-planner or research |
| "帮我想" / "想选题" / seed idea | topic-ideas |
| "写这个" / "帮我写" / "写一篇" | spawn-writer |
| "批量写" / "都写了" / "写N篇" | spawn-batch-writer |
| "改写" / "适配" / "发到XX平台" | platform-rewrite |
| "去AI味" / "润色" | humanizer-zh |
| "审核" / "检查" / "敏感词" | content-review |
| "封面" / "生成封面" / "做个封面" | cover-generator |
| "发布前检查" | pre-publish |
| "发布" / "发到小红书" | publish-content |
| "自动化" / "定时" / "pipeline" | manage-pipeline |
| User gives feedback on content | memory-distill |
| "状态" / "进度" | autocrew_status tool |
| "对标" / "监控" / competitor URL | [Pro] competitor-monitor |
| Video/note URL + "分析/拆解" | [Pro] video-analysis |
| Video/note URL (no analysis intent) | [Pro] extract-video-script |
| "数据" / "分析报告" | [Pro] analytics-report |
