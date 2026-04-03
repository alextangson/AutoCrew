# Title Methodology System Design

> Date: 2026-04-03
> Status: Approved, pending implementation

## Background

AutoCrew's current title generation relies on simple scoring (length, numbers, emotional triggers) and a handful of templates. There is no structured methodology guiding the LLM on *how to think about* creating compelling titles.

The user provided a comprehensive title methodology (based on interior design examples) covering 8 psychological mechanisms, multiple sub-methods, and a quality checklist. The goal is to extract domain-agnostic principles and integrate them as LLM guidance.

## Design Decisions

- **Approach A (pure Skill guidance)** — methodology lives in a Skill's SKILL.md as LLM prompt guidance. No structured data, no code-level enforcement.
- Rationale: methodology's value is in guiding LLM creative thinking, not in code pattern-matching. Markdown is sufficient for LLM comprehension.

## 1. New Skill: `title-craft`

Create `skills/title-craft/SKILL.md` — a **reference skill** (not standalone executable) containing the domain-agnostic title methodology.

Written in English. Content structure:

### 8 Title Types (Domain-Agnostic)

| Type | Core Mechanism | Formula |
|------|---------------|---------|
| Emotional Resonance | Reader feels "understood" | [Honest expression] + [Real emotion] |
| Precision Lens | Target reader feels "this is about ME" | [Specific persona/scenario] + [Concrete solution] |
| Transformation Contrast | Show before/after, spark desire for change | [Problem state] + [Surprising result] |
| Emotion Trigger | Hit pain points or satisfy aspirations | [Warning words] + [Common mistakes] OR [Premium words] + [Ideal outcome] |
| Perspective Elevation | Connect details to bigger value | [Specific detail] + [Life/career upgrade] |
| Urgency & Scarcity | Create "miss it and regret" feeling | [Time pressure word] + [Scarce resource] + [Action word] |
| Pattern Breaker | Defy expectations, spark curiosity | [Exaggeration] + [Unconventional approach] OR [Secret hint] + [Insider experience] |
| Authority & Proof | Build credibility | [Authority endorsement] + [Professional content] OR [Number + method] + [Clear outcome] |

Each type includes:
- Core psychological mechanism explanation
- 2-3 classic sub-methods as examples (open-ended, LLM can develop new variants)
- Judgment criterion: what makes a title qualify as this type

### Universal Quality Checklist (5 Questions)

1. **Targeting** — Does it address a specific persona or scenario?
2. **Emotion** — Does it trigger concern, anticipation, or curiosity?
3. **Value** — Does it help the reader solve a problem or level up?
4. **Curiosity** — Does it create an urge to click/tap?
5. **Credibility** — Does it feel authentic and trustworthy (not clickbait)?

### Practical Techniques (Cross-Domain)

- Write 3-5 versions, pick the strongest
- Numbers beat vague quantifiers ("3 methods" > "several methods")
- Emoji adds visual impact (platform-dependent)
- First person > third person ("I tried" > "someone tried")
- Combine 2 types for differentiation (e.g., Precision Lens + Transformation Contrast)

### Platform-Specific Title Guidelines

Reference real platform limits (data maintained in `title-hashtag.ts`):

| Platform | Title Hard Limit | Recommended | Visible Chars | Key Guidance |
|----------|-----------------|-------------|---------------|-------------|
| Xiaohongshu | 20 | 10-18 | 20 | Every character counts. Emoji OK. Conversational tone. |
| Douyin | 300 (caption) | 15-55 | ~55 before fold | Hook must be in first 55 chars. Rest is bonus. |
| Bilibili | 80 (system) | 12-24 | 20-24 | Use brackets for labels. Youth-friendly. |
| WeChat MP | 64 | 20-30 | 64 | Info-dense. Colons to separate halves. Data builds trust. |
| Toutiao | 30 (min 5) | 15-30 | 30 | Two-segment style. Direct value proposition. |
| YouTube | 100 | 30-70 | 60-70 | Front-load keywords. English-friendly if bilingual audience. |
| Twitter/X | 280 (whole tweet) | 60-140 | 280 | No separate title. Hook is the first line. |
| Instagram | 2200 (caption) | 60-125 | 125 before "more" | First line IS the title. Emoji-heavy culture. |

When adapting across platforms, do NOT just truncate. Re-craft using a title type suited to the target platform's constraints and audience behavior.

## 2. Platform Limits Data Update

Update `src/modules/writing/title-hashtag.ts` `getPlatformRules()` with researched real data:

```
xiaohongshu:  titleMax: 20,   bodyMax: 1000,  recommended: [10, 18]
douyin:       titleMax: 300,  bodyMax: 300,   recommended: [15, 55],  visibleChars: 55
bilibili:     titleMax: 80,   bodyMax: 2000,  recommended: [12, 24]
wechat_mp:    titleMax: 64,   bodyMax: 50000, recommended: [20, 30]
toutiao:      titleMax: 30,   bodyMax: 5000,  recommended: [15, 30],  titleMin: 5
youtube:      titleMax: 100,  bodyMax: 5000,  recommended: [30, 70]
twitter:      titleMax: 280,  bodyMax: 280,   recommended: [60, 140]
instagram:    titleMax: 2200, bodyMax: 2200,  recommended: [60, 125]
```

Add `visibleChars` field for platforms where titles are truncated.

## 3. Integration Points (Skill References Only)

Three existing skills add a reference line to `title-craft`:

### 3a. `topic-ideas/SKILL.md`

Before generating titles, review title methodology. Select 1-2 title types matching topic angle and audience.

### 3b. `spawn-writer/SKILL.md`

When writing, generate 3-5 title variants using different types. Present with type labels for user to choose.

### 3c. `platform-rewrite/SKILL.md`

When adapting across platforms, re-craft titles using methodology fitted to target platform constraints. Don't just truncate.

## Summary of Changes

| Change | Type | Files |
|--------|------|-------|
| Title methodology skill | New skill | `skills/title-craft/SKILL.md` |
| Platform limits update | Code update | `src/modules/writing/title-hashtag.ts` |
| topic-ideas reference | Skill update | `skills/topic-ideas/SKILL.md` |
| spawn-writer reference | Skill update | `skills/spawn-writer/SKILL.md` |
| platform-rewrite reference | Skill update | `skills/platform-rewrite/SKILL.md` |

## Not in Scope

- Code-level title type detection or scoring
- Structured YAML/JSON methodology data
- New CLI commands
- New MCP tools
