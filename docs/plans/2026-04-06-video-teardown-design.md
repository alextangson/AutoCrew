# Video Teardown Design

## Overview

Extend the existing `teardown` skill with multimodal video analysis powered by MiMo-V2-Omni.
When the user provides a video link or file, the skill downloads the video via a pluggable
crawler, sends it to Omni for full-modal analysis, and produces a structured teardown report
grounded in communication theory, psychology, content architecture, and audiovisual language.

Results persist to `intel/_teardowns/` and flow into the knowledge-wiki pipeline for
cross-session reuse in content creation.

## Architecture

Extend `skills/teardown/SKILL.md` (not a new skill). Input detection routes to text vs video
path. Video path: crawler → Omni API → structured report → intel ingest → wiki sync.

## Input Detection

| Input | Detection | Path |
|-------|-----------|------|
| Plain text / post | No URL, no file path | Existing text teardown (unchanged) |
| Video link | URL contains douyin/xiaohongshu/bilibili/youtube/weixin etc. | Video teardown |
| Local video file | Path ends with .mp4/.mov/.avi | Video teardown (skip crawler) |

## Video Acquisition Layer

Pluggable crawlers configured in `creator-profile.json`:

```typescript
videoCrawler?: {
  type: "mediacrawl" | "playwright" | "manual";
  command?: string;  // mediacrawl command, e.g. "python3 /path/to/main.py"
};
```

| Crawler | Flow |
|---------|------|
| mediacrawl | Bash call to user's local MediaCrawl installation → returns local file |
| playwright | Browser automation with login session → download video → local file |
| manual (default) | Prompt user to download and provide file path |

## Omni API Integration

Configuration in `creator-profile.json`:

```typescript
omniConfig?: {
  baseUrl: string;     // default "https://api.xiaomimimo.com/v1"
  model: string;       // default "mimo-v2-omni"
  apiKey: string;
};
```

Call pattern (OpenAI-compatible):
```python
client = OpenAI(base_url=omniConfig.baseUrl, api_key=omniConfig.apiKey)
response = client.chat.completions.create(
  model=omniConfig.model,
  messages=[{
    "role": "user",
    "content": [
      {"type": "text", "text": "<teardown prompt with full template>"},
      {"type": "image_url", "image_url": {"url": f"data:video/mp4;base64,{video_base64}"}}
    ]
  }]
)
```

### Limits
- Video duration: max 30 minutes
- File size: max 200MB
- Over-limit: inform user with specific limit, suggest trimming

## Teardown Analysis Template (v2)

Four disciplinary lenses, each answering one core question:

### 1. Communication Theory — Why does this spread?

**Information Asymmetry Design:**
- What does the creator know that the audience doesn't? How is the gap manufactured?
- Reveal pacing: all at once vs layered disclosure?

**Social Currency:**
- What is the viewer expressing by sharing this?
  ("I'm smart" / "I have taste" / "I care about you" / "look at this crazy thing")
- Berger's STEPPS hit: Social Currency / Triggers / Emotion / Public / Practical Value / Stories

**Framing Effect:**
- What frame did the creator choose for this information?
- How would a different frame change perception?

### 2. Psychology — What is the viewer's brain experiencing?

**Cognitive Load Management:**
- How are complex ideas chunked? How heavy is each information unit?
- Are there "cognitive rest zones" (jokes, pauses, repetition)?

**Emotional Arc:**
- Map the emotion curve: opening → peaks → valleys → ending
- Peak-End Rule: which peak moment and ending feeling will the viewer remember?

**Identity Projection:**
- Who does the viewer feel they are after watching? ("I'm smart" / "I'm not alone" / "I can act")
- Which Maslow level does this satisfy? (belonging / esteem / self-actualization)

**Open Loops & Zeigarnik Effect:**
- How many unclosed information gaps? When opened, when closed?
- Does the viewer leave "satisfied" or "curious"?

### 3. Content Architecture — Is the argument effective?

**Argument Structure:**
- Core argument chain: claim → evidence type (data/case/authority/analogy) → objection handling → CTA
- Where might viewers start questioning?

**Promise-Delivery Analysis:**
- What did the first 3 seconds promise (implicit or explicit)?
- Was it delivered? Over-delivered or under-delivered?
- If under: does the viewer feel deceived?

**Information Density Curve:**
- Which sections are high-density (new concepts/data packed)?
- Which are breathing room (repetition/examples/emotional rendering)?
- Is the density rhythm appropriate?

**Opinion Spectrum Positioning:**
- Where on the consensus ← → contrarian spectrum?
- Is the contrarian degree calibrated? (Too contrarian = lose trust; too consensus = no spread value)

### 4. Audiovisual Language — How does form serve content?

**Visual Narrative:**
- What information does the image convey that the script doesn't?
- Key frame selection: why this visual at this argument point?

**Rhythm & Attention (Clock Theory):**
- 12/3/6/9 bang moment mapping
- Does edit rhythm sync with argument rhythm?

**HKRR Diagnosis:**
- Dominant dimension (H/K/R/R) and purity
- Dimension conflicts? (trying to teach AND be funny = neither lands)

### 5. Actionable Takeaways (core output)

**Methodology-level (transferable to any topic):**
- Reusable "formulas" the creator employed

**Style-level (needs adaptation):**
- Good but doesn't match our voice — how to adjust?

**Not applicable:**
- Why not? Audience mismatch or capability boundary?

**Inspiration:**
- New topic ideas / angles / expression techniques sparked

## Storage & Pipeline Integration

### Dual write

```
Report
  ├─ intel/_teardowns/{date}-{slug}.md  (full report, frontmatter + markdown)
  └─ autocrew_intel ingest(text=summary) → knowledge-sync → wiki pages
```

### Frontmatter (extends existing text teardown format)

```yaml
---
title: "拆解: {video title}"
type: teardown
mode: video
platform: "douyin"
source_url: "https://..."
source_account: "@account"
video_duration: "12:30"
analysis_model: "mimo-v2-omni"
dominant_hkrr: "K"
overall_score: 8
created_at: "2026-04-06T..."
tags: [teardown, video, ai-tools]
---
```

New fields: `mode`, `video_duration`, `analysis_model`, `source_account`.
Compatible with existing text teardowns — write-script searches `_teardowns/` without changes.

## Teardown Skill Flow (extended)

```
1. Detect input type (text vs video link vs video file)
2. [video] Acquire video via configured crawler → local file path
3. [video] Extract metadata if available (title, account, stats)
4. [video] Encode video → base64 → send to Omni API with template v2 prompt
5. [video] Format structured report from Omni response
6. Write report to intel/_teardowns/{date}-{slug}.md
7. Call autocrew_intel ingest → triggers knowledge-sync
8. Present report to user + next steps:
   > 拆解报告已保存。要基于这个拆解写一篇内容吗？
```

## creator-profile.json Extensions

```typescript
// Add to CreatorProfile interface:
videoCrawler?: {
  type: "mediacrawl" | "playwright" | "manual";
  command?: string;
};
omniConfig?: {
  baseUrl: string;   // default "https://api.xiaomimimo.com/v1"
  model: string;     // default "mimo-v2-omni"
  apiKey: string;
};
```

## Implementation Scope

| Component | Type | Effort |
|-----------|------|--------|
| Extend teardown SKILL.md with video path | Modify existing skill | Medium |
| Teardown analysis template v2 | New content in skill | Medium |
| CreatorProfile interface extension | Modify existing type | Minimal |
| Profile initialization for new fields | Modify existing | Minimal |
| _teardowns/ directory creation in initPipeline | Modify existing | Minimal |

No new tools, no new modules. One skill extension + type extension.

## Date

2026-04-06
