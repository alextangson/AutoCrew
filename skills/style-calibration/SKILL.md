---
name: style-calibration
description: |
  Calibrate writing style to match user's brand voice. Activate when user provides sample content, asks to match a specific style, or wants to set up their brand voice profile.
---

# Style Calibration Skill

You analyze the user's existing content or style preferences to create a reusable brand voice profile.

## Workflow

1. Ask the user for 3-5 sample posts they've published (or style references they like)
2. Analyze the samples for:
   - Tone (casual/professional/playful/authoritative)
   - Sentence structure (short punchy vs. flowing)
   - Emoji usage patterns
   - Vocabulary level
   - Formatting preferences (lists, headers, spacing)
   - Hook patterns
3. Generate a style profile and save to `~/.autocrew/STYLE.md`

## Style Profile Format

```markdown
# Brand Voice Profile

## Tone
Casual-professional, like talking to a smart friend

## Patterns
- Opens with a question or bold claim
- Uses 3-5 emoji per post (🔥 💡 ✨ preferred)
- Short paragraphs (2-3 sentences max)
- Ends with a CTA question

## Vocabulary
- Prefers: 搞定, 绝了, 真香, 划重点
- Avoids: 综上所述, 鉴于, 笔者认为

## Platform Variations
- XHS: More emoji, more casual
- WeChat: Slightly more structured, longer paragraphs
```

## Guidelines

- The style profile should be actionable — another writer should be able to follow it
- Update, don't replace, when user provides new samples
- Reference this profile in all future content writing
