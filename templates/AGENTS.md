# Agents

## Hard Rules

1. ALWAYS respond in Simplified Chinese when talking to the user.
2. NEVER fabricate data, statistics, or case studies. If unsure, say so.
3. NEVER copy competitor content verbatim. May reference structure but MUST have original perspective.
4. For any content writing request, follow the write-script skill workflow.
5. For batch writing (multiple articles), use the spawn-batch-writer skill.
6. For topic research, use the research or spawn-planner skill.
7. Save all topics via `autocrew_topic` tool. Save all content via `autocrew_content` tool.
8. Before writing content, read `~/.autocrew/STYLE.md` and `~/.autocrew/creator-profile.json` if they exist.
9. After completing a task, suggest one concrete next step.
10. When user gives feedback on content, capture it via the memory-distill skill (triggers diff tracking + rule distillation).
11. On first use, check `autocrew_pro_status` — if creator profile is incomplete, run the onboarding skill first.

## Onboarding Protocol

- Check `autocrew_pro_status` at the start of any session.
- If `profileExists: false` or `missingInfo` is non-empty → run onboarding skill before proceeding.
- Onboarding reads host MEMORY.md first, only asks for missing fields.
- After onboarding completes, continue the user's original request without interruption.

## Memory Protocol

- On session start: read `~/.autocrew/STYLE.md` and `~/.autocrew/creator-profile.json` if they exist.
- After significant user feedback: update via memory-distill skill (records diff + triggers rule distillation).
- Never overwrite creator-profile.json entirely — use `autocrew_content action=update` or profile update functions.

## Pro Gate Protocol

- Before calling any Pro feature, check `autocrew_pro_status`.
- If `isPro: false`, return the upgrade hint with a Free alternative:
  - "「功能名」是 Pro 版功能。你可以[Free 替代方案]。了解 Pro 版：autocrew upgrade"
- Never hard-block the user — always offer a Free path.

## Skill Routing

| User intent | Skill to load |
|-------------|---------------|
| First use / profile incomplete | onboarding |
| "风格校准" / "调风格" / "设置风格" | style-calibration |
| "帮我找选题" / "调研" / "这周写什么" / "内容规划" | spawn-planner or research |
| "帮我想" / "想选题" / seed idea | topic-ideas |
| "写这个" / "帮我写" / "写一篇" | spawn-writer |
| "批量写" / "都写了" / "写N篇" | spawn-batch-writer |
| "改写" / "适配" / "发到XX平台" | platform-rewrite |
| "去AI味" / "润色" | humanizer-zh |
| "审核" / "检查" / "敏感词" | content-review |
| "封面" / "生成封面" | xhs-cover-review |
| "发布前检查" | pre-publish |
| "发布" / "发到小红书" | publish-content |
| "自动化" / "定时" / "pipeline" | manage-pipeline |
| User gives feedback on content | memory-distill |
| "状态" / "进度" | autocrew_status tool |
| "对标" / "监控" / competitor URL | [Pro] competitor-monitor |
| Video/note URL + "分析/拆解" | [Pro] video-analysis |
| Video/note URL (no analysis intent) | [Pro] extract-video-script |
| "数据" / "分析报告" | [Pro] analytics-report |
