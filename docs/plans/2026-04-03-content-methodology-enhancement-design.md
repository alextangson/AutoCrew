# Content Methodology Enhancement Design

Date: 2026-04-03

## Overview

Enhance AutoCrew's content creation pipeline with 6 new methodologies on top of 4 existing priority fixes. Goal: transform from "structurally correct but emotionally flat" content to content with viral sense (网感).

## Part 1: Original 4 Priority Fixes

### P1: Auto-humanize + review at tool level

**Problem:** write-script skill says "MANDATORY" but LLM ignores it.

**Solution:** In `content-save.ts`, after save action completes, programmatically call `executeHumanize()` with `save_back: true`, then call content-review executor. Inline, not hook-based.

**Files:** `src/tools/content-save.ts`

### P2: Concrete content methodology in write-script

**Problem:** Generic "5-8 points, 80-150 chars" produces flat content.

**Solution:** Rewrite SKILL.md body section with hook patterns, rhythm rules, anti-patterns, HKRR annotation, Clock position mapping. Now also includes title formulas, comment engineering, and completion rate micro-techniques (see Part 2).

**Files:** `skills/write-script/SKILL.md`

### P3: Version management on update

**Problem:** Update overwrites content, no history.

**Solution:** In content-save.ts update action, when `body` is present, call existing `addDraftVersion()` from pipeline-store.ts. For old storage, also save to `versions/vN.md`.

**Files:** `src/tools/content-save.ts`, `src/storage/local-store.ts`

### P4: Traffic hypothesis per content

**Problem:** No structured way to record what each content tests.

**Solution:** Add to ProjectMeta: `hypothesis`, `experimentType` (title_test / hook_test / format_test / angle_test), `controlRef`, `hypothesisResult` (confirmed / rejected / inconclusive).

**Files:** `src/storage/pipeline-store.ts`, `skills/write-script/SKILL.md`, `skills/content-review/SKILL.md`

## Part 2: Content Methodology Enhancements

### 2.1 Title Formula Library

**Location:** write-script SKILL.md title generation step

**6 formula types:**
- Number + Result: "用了3个月AI，我把团队从12人砍到3人"
- Contrarian: "AI写的代码比人快10倍，但我劝你别用"
- Identity + Pain: "传统老板看过来：这3种AI项目100%是坑"
- Curiosity Gap: "花了20万做AI系统，结果…"
- Contrast: "别人用AI赚钱，你用AI亏钱，差在哪？"
- Resonance Question: "为什么你学了那么多AI课，还是不会用？"

**Rules:**
- Every content MUST produce 3-5 candidate titles with formula annotation
- content-review checks title hits at least one formula

### 2.2 Comment Engineering

**Location:** write-script SKILL.md body generation + output format

**Trigger types:**
- Controversy plant: leave a debatable point ("我知道很多人不同意，但…")
- Unanswered question: raise but don't fully resolve, invite discussion
- Quote hook: one sentence worth screenshotting/sharing

**Output:** New `commentTriggers[]` field with type and position in body.

**Review:** content-review checks at least 1 comment trigger exists.

### 2.3 Completion Rate Micro-techniques

**Location:** HAMLETDEER.md new subsection under Clock Theory + write-script reference

**4 techniques:**
- Open Loop: raise question early, delay answer
- Curiosity Gap: every ~30s create a "what's next?"
- Visual Anchor: insert high-density quote between paragraphs
- Rhythm Break: sudden ultra-short sentence in long paragraph

**Rules:**
- write-script requires annotating at least 2 micro-techniques in body
- content-review Clock Audit adds micro-technique check

## Part 3: Content Flywheel, Positioning & Teardown

### 3.1 Content Flywheel (Data Feedback Loop)

**Flow:** Publish → Chrome Relay auto-scrape → Attribution analysis → Learning → Feed next content

**Data collection:**
- Chrome Relay logs into platform creator dashboards, simulates human behavior
- Passive automation — zero manual input from user
- Fields: views, completion rate, likes, saves, comments, shares, top comments
- Stored in ProjectMeta `performanceData`

**Attribution analysis (auto-triggered after data collection):**
- Performance rating: viral / on-target / below-expectation
- Core attribution (single-select): strong title / good hook / right topic / timing / luck
- Hypothesis verification: confirmed / rejected / inconclusive
- One-line learning: "this angle works for 王总 persona" / "contrarian title +40% completion on XHS"
- Stored in `performanceLearnings[]`

**Learning distillation:**
- Every 5 attributions, auto-summarize patterns
- Prompt user to confirm, then write to creator-profile.json writingRules
- Example: 3 consecutive "contrarian title" hits → new rule: `{ rule: "反常识标题在小红书效果最佳", source: "auto_distilled", confidence: 0.8 }`

**This iteration scope:**
- Define interfaces and data structures (ProjectMeta extension, performanceData, performanceLearnings)
- Attribution analysis skill
- Learning distillation logic
- Chrome Relay data scraping: interface only, actual Relay integration deferred

### 3.2 Content Positioning

**Concept:** Add `contentPillars` to creator-profile.json

**Data structure:**
```typescript
interface ContentPillar {
  name: string;                 // e.g., "AI落地避坑"
  targetPersona: string;        // maps to audiencePersona
  valueProposition: string;     // one-line value
  contentRatio: number;         // % of total content (all pillars sum to 100)
  toneGuide: string;            // voice for this pillar
  exampleAngles: string[];      // seed angles
}
```

**Integration points:**
- Init: guide user to define 2-4 pillars during first setup
- write-script: MUST specify which pillar this content belongs to
- content-review: check recent content ratio vs target ratio, flag imbalance
- teardown: analyze competitor's pillar distribution, inform positioning

### 3.3 Competitive Teardown

**Two-tier architecture:**

| | Free | Pro |
|---|---|---|
| Input | User pastes text | Video URL / account name |
| Data | Direct text analysis | Chrome Relay scrape / multimodal video analysis |
| Depth | Copy structure teardown | Copy + visuals + rhythm + performance data |

**Free version teardown template (this iteration):**
- Hook analysis: hook type + title formula match
- HKRR scoring: 4 dimensions, identify strongest
- Clock mapping: content → clock positions, bang moments
- Comment triggers: where are controversy/question/quote hooks?
- Completion micro-techniques: which retention tricks used?
- One-line summary: why this content works / doesn't
- Results stored in `pipeline/intel/teardowns/`

**Pro version (interface reserved, deferred):**
- Input account name → Chrome Relay scrape last 20 posts
- Batch teardown → account-level analysis: pillar distribution, viral patterns, posting frequency
- Compare against own account data

**Skill:** `/teardown`
- Independent skill, decoupled from write-script
- write-script auto-fetches relevant teardowns from intel as reference during creation

## Implementation Scope (This Iteration)

**Implement now:**
- P1-P4 (all 4 original fixes)
- Title formula library (in write-script)
- Comment engineering (in write-script + content-review)
- Completion rate micro-techniques (in HAMLETDEER.md + write-script + content-review)
- Content positioning: contentPillars in creator-profile + write-script + content-review integration
- Hypothesis fields in ProjectMeta
- Flywheel: data structures + attribution skill + learning distillation logic
- Teardown: free version `/teardown` skill + intel storage

**Defer to later:**
- Chrome Relay data scraping integration
- Pro teardown (account-level batch analysis)
- Init flow for content pillar setup (can manually configure first)
