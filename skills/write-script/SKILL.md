---
name: write-script
description: Content writing workflow for Chinese social media
---

# Write Script

## Boundaries (violations = restart)

- NEVER fabricate data, statistics, or case studies
- NEVER use AI filler phrases: 值得一提的是, 综上所述, 首先/其次/最后, 一方面/另一方面
- NEVER skip the skeleton phase — no prose before structure is confirmed
- NEVER save content via Write tool — always use autocrew_content action="save"
- Title MUST be ≤20 Chinese characters (including punctuation and emoji)

## Before Writing — Think

Answer these questions (in your thinking, not in output):

### 1. Who am I writing for?
- Load `~/.autocrew/STYLE.md` and `~/.autocrew/creator-profile.json`
- Picture ONE specific person from the audiencePersona
- What are they feeling right now? What problem keeps them up?

### 2. What is my ONE opinion?
- Not a topic — an OPINION. "AI编程" is a topic. "AI编程让不会写代码的人更危险" is an opinion.
- State it in one sentence. If you can't, you're not ready to write.

### 3. What is my hypothesis?
- What does this content test? "I believe [hook type] + [angle] will get [metric] because [reason]"
- This goes into the `hypothesis` field when saving.

### 4. What evidence do I have?
- Creator's own experience is the strongest evidence (first person > third person)
- Load wiki knowledge if available (autocrew_content action="draft" returns it)
- If evidence is thin, use autocrew_intel action="pull" to gather more

### 5. What is the emotional arc?
- Clock Theory: plan 4 energy peaks (hook → escalation → payload → climax)
- Every section must either OPEN a question or CLOSE one
- Where does tension come from? Contradiction? Surprise? Vulnerability?

## Writing Process

1. **Present skeleton** — thesis, structure (argument flow), 4 clock moments, HKRR dimension. Wait for user confirmation.
2. **Write full draft** — fear short, not long. Every case study deserves full detail. Ground factual claims in real sources.
3. **Self-review** — run the Quality Checklist below mentally before saving.

## Quality Checklist (before save)

Ask yourself:
- [ ] Does every paragraph earn the reader's next 3 seconds?
- [ ] Would the reader say these words to a friend over coffee?
- [ ] Is there a specific scene/number/moment for every claim? (No bare abstractions)
- [ ] Does the opening hook create immediate tension or curiosity?
- [ ] Is the creator's voice present? (I did X > Company Y did Z)

## Save

```
autocrew_content action="save"
  title: ≤20 chars
  body: full draft
  platform: target platform
  hypothesis: what this tests
  comment_triggers: at least 1
```

Auto-humanization and review run automatically after save — do not call them manually.

## Revision Handling

If user requests changes:
1. Read feedback carefully — what specifically is wrong?
2. Make targeted edits (don't rewrite from scratch unless asked)
3. Save updated version via autocrew_content action="update"

## Platform Adaptation

After the primary draft is saved, if user wants to publish on additional platforms:
- Use autocrew_rewrite action="batch_adapt" for multi-platform rewrites
- Each platform has different title length limits and content norms
- Load title-craft skill for platform-specific title methodology
