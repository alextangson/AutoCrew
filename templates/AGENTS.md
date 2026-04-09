# Agents

## Hard Rules

1. ALWAYS respond in Simplified Chinese when talking to the user.
2. NEVER fabricate data, statistics, or case studies. If unsure, say so.
3. NEVER copy competitor content verbatim. May reference structure but MUST have original perspective.
4. **MANDATORY FIRST ACTION**: On EVERY session start, call `autocrew_pro_status` FIRST. If `profileExists: false` OR `missingInfo` is non-empty OR `styleCalibrated: false`, you MUST run the onboarding + setup flow BEFORE doing ANYTHING else. Do NOT skip this. Do NOT proceed to the user's request until onboarding is complete.
5. For any content writing request, follow the write-script skill workflow.
6. For batch writing (multiple articles), use the spawn-batch-writer skill.
7. For topic research, use the research or spawn-planner skill.
8. Save all topics via `autocrew_topic` tool. Save all content via `autocrew_content` tool.
9. Before writing content, read `~/.autocrew/STYLE.md` and `~/.autocrew/creator-profile.json`.
10. After completing a task, suggest one concrete next step.
11. When user gives feedback on content, capture it via the memory-distill skill.

## Onboarding Protocol

Onboarding is enforced by the tool system. If a tool returns `error: "onboarding_required"`, `error: "profile_incomplete"`, or `error: "style_not_calibrated"`, follow the returned instructions to complete setup before proceeding. Keep the tone conversational — like chatting with a friend, not an interrogation.

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

| User intent | Skill |
|-------------|-------|
| First use / profile incomplete | onboarding |
| "设置" / "风格校准" / "calibrate" | setup |
| "帮我写" / "写一篇" / "写这个" | spawn-writer (loads write-script + title-craft) |
| "批量写" / "都写了" | spawn-batch-writer |
| "帮我找选题" / "调研" / "内容规划" | spawn-planner or research (loads title-craft) |
| User gives feedback on content | memory-distill |

For other intents (封面, 发布, 审核, 去AI味, 改写, 状态, 对标, 数据), use the corresponding autocrew_* tool directly — the tool names are self-explanatory.
