# Video Pipeline Design: Auto-Composition Engine

## Problem

AutoCrew has a complete script-writing pipeline but stops at text. The gap between script and published video (asset generation, editing, composition) is the biggest pipeline break. Users must manually handle TTS, B-roll, subtitles, and video assembly.

## Design Philosophy

AutoCrew is NOT an editing tool. It's an **auto-composition engine**.

- Fixed presets, not free-form editing
- Low error rate over maximum flexibility
- Consistent aesthetic over creative control
- "Press the button, get the video" — like iPhone camera

## Architecture

### Package Split

```
@autocrew/core (MCP plugin, lightweight, no heavy deps)
├── Script generation (existing)
├── Timeline markup engine (new)
│   ├── AI auto-markup: script → marked script with [card]/[broll] tags
│   └── Markup parser: marked script → timeline.json
├── HTML knowledge card template engine (new)
│   ├── Built-in templates: comparison-table, key-points, flow-chart, data-chart
│   └── User custom templates: ~/.autocrew/templates/
├── Provider interface definitions (new, interfaces only)
│   ├── TTSProvider
│   ├── VideoProvider
│   └── CompositorProvider
└── Web UI asset panel (new, Descript-style)

@autocrew/studio (standalone CLI, user installs separately)
├── Provider implementations
│   ├── TTS: EdgeTTS / Doubao / MiniMax / Fish Audio / custom
│   ├── Video: Kling / Luma / Runway / custom
│   └── Screenshot: Puppeteer (HTML card → image)
├── Compositor implementations
│   ├── FFmpegCompositor (local, for power users)
│   ├── CloudCompositor (remote API, Pro tier)
│   └── JianyingExporter (export as Jianying project file)
└── CLI commands
    ├── autocrew render              # auto-compose full video
    ├── autocrew render --jianying   # export Jianying project
    ├── autocrew render --preview    # preview timeline
    └── autocrew config              # configure providers
```

### Key Principle

Core never depends on ffmpeg, puppeteer, or any heavy package. Studio is opt-in.

## Pipeline Flow

```
Script (core)
  → AI auto-markup (core)
  → timeline.json (core)
  → Web UI: Descript-style asset panel — review & adjust (core)
  → Asset generation: TTS + B-roll + card screenshots (studio)
  → Composition / Export (studio)
```

## timeline.json Specification

```json
{
  "version": "2.0",
  "contentId": "abc-123",
  "preset": "knowledge-explainer",
  "aspectRatio": "9:16",
  "subtitle": {
    "template": "modern-outline",
    "position": "bottom"
  },
  "tracks": {
    "tts": [
      {
        "id": "tts-001",
        "text": "Today we talk about three productivity tools",
        "estimatedDuration": 3.2,
        "start": 0,
        "asset": null,
        "status": "pending"
      }
    ],
    "visual": [
      {
        "id": "vis-001",
        "layer": 0,
        "type": "broll",
        "prompt": "city aerial shot at night, cinematic",
        "linkedTts": ["tts-001", "tts-002"],
        "asset": null,
        "status": "pending"
      },
      {
        "id": "vis-002",
        "layer": 1,
        "type": "card",
        "template": "comparison-table",
        "data": {
          "title": "Three Tools Compared",
          "rows": [
            { "name": "Notion", "pros": "All-in-one", "cons": "Learning curve" },
            { "name": "Obsidian", "pros": "Local-first", "cons": "No collab" }
          ]
        },
        "linkedTts": ["tts-001"],
        "opacity": 0.85,
        "asset": null,
        "status": "pending"
      }
    ],
    "subtitle": {
      "asset": null,
      "status": "pending"
    }
  }
}
```

### Duration Strategy

TTS is the single time anchor. Visual duration = sum of linked TTS actual durations.

- Video longer than TTS → trim tail
- Video shorter than TTS → slow to 0.7x, or loop
- Tolerance: 0.5s

### Asset Status Flow

```
pending → generating → ready → confirmed
              ↓
           failed → pending (retry)
```

- `pending`: awaiting generation
- `generating`: studio calling API
- `ready`: asset generated, awaiting user confirmation in Web UI
- `confirmed`: user approved, ready for composition
- `failed`: generation failed, can retry

## Presets

### knowledge-explainer (Knowledge Explainer)

Primary use: knowledge sharing, topic explanation, listicles.

- Visual mix: ~60% knowledge cards, ~40% B-roll transitions
- Transitions: crossfade 0.3s (fixed)
- Card animation: fade-in + slide-up (fixed)
- B-roll style: cinematic, slow motion
- Subtitle: bound to preset

### tutorial (Tutorial)

Primary use: step-by-step guides, how-to content.

- Visual mix: step cards with numbering + screen recording placeholders
- Transitions: cut (no fade, cleaner for tutorials)
- Card animation: slide-left sequential reveal
- Screen recording: placeholder segments user fills with actual recordings

## Aspect Ratios

```
"9:16"  — Douyin, Kuaishou, Reels (vertical)
"16:9"  — Bilibili, YouTube (horizontal)
"3:4"   — Xiaohongshu (portrait)
"1:1"   — WeChat Moments (square)
"4:3"   — WeChat Video Channel
```

One render = one ratio. Multi-platform = multiple renders (assets reused, only cards re-laid out).

## Subtitle Templates

Fixed templates, no customization. Guaranteed aesthetic.

| Template | Style | Best For |
|----------|-------|----------|
| `modern-outline` | White text, black outline, bottom center | Universal, safest |
| `karaoke-highlight` | Word-by-word highlight | Douyin style |
| `minimal-fade` | Small text, fade in/out | Bilibili style |
| `bold-top` | Bold text, top position | Emphasis, headline |

## Web UI: Descript-Style Asset Panel

Located in content detail page as "Assets" tab, alongside script editor.

### Layout

```
┌──────────────────────┬──────────────────────────────┐
│ Script (editable)    │ Visual Preview               │
│                      │                              │
│ Paragraph 1 text     │ ┌────────────────────┐       │
│ ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈   │ │ Preview of current │       │
│ 📊 card: comparison  │ │ segment's visual   │       │
│                      │ └────────────────────┘       │
│ Paragraph 2 text     │                              │
│ ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈   │ Actions:                     │
│ 🎬 broll: cityscape  │ [🔄 Regenerate]              │
│                      │ [📝 Edit prompt/content]      │
│ Paragraph 3 text     │ [📤 Upload local replacement] │
│ ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈   │                              │
│ 📊 card: key-points  │ ─────────────────────        │
│                      │ ▶ 00:03.2 / 00:45.0          │
│                      │                              │
│                      │ [▶️ Preview] [💾 Confirm]     │
└──────────────────────┴──────────────────────────────┘
```

### Interactions

- Click any paragraph → right panel shows corresponding visual preview
- Edit script text → linked visual prompt auto-updates (AI re-suggests)
- Each visual block: regenerate, edit prompt, upload local file, switch template
- Knowledge cards: inline HTML content editing
- Preview: rough cut playback of confirmed segments
- Confirm all → trigger studio render

## Provider Adapter Interfaces

```typescript
interface TTSProvider {
  name: string
  generate(text: string, voice: VoiceConfig): Promise<AudioAsset>
  estimateDuration(text: string): number
  listVoices(): Promise<Voice[]>
}

interface VideoProvider {
  name: string
  generate(prompt: string, config: VideoConfig): Promise<VideoAsset>
  supportedRatios(): AspectRatio[]
}

interface CompositorProvider {
  name: string
  compose(timeline: Timeline, assets: AssetMap): Promise<VideoFile>
  export(timeline: Timeline, assets: AssetMap, format: ExportFormat): Promise<ProjectFile>
}

type ExportFormat = 'jianying' | 'davinci' | 'fcpx'
```

Users configure their preferred providers in `~/.autocrew/studio.config.json`.

## Commercial Model

| Feature | Free | Pro |
|---------|------|-----|
| Script + timeline markup | Yes | Yes |
| Web asset panel | Yes | Yes |
| Jianying export | Yes | Yes |
| Local ffmpeg composition | Yes | Yes |
| HTML card templates | Basic (4) | Extended library |
| Cloud composition | No | Yes |
| Voice cloning | No | Yes |
| AI video generation quota | No | Yes (via provider) |
| Custom card templates | Yes | Yes |

## Markup Syntax

AI auto-inserts these into scripts. Users can edit in Web UI.

```markdown
今天我们聊聊三个效率工具
[card:comparison-table title="三款工具对比" rows="Notion:全能:学习曲线,Obsidian:本地:无协作"]

第一个是 Notion
[broll:notion app界面操作画面，暗色主题 duration=5s]

它最强的地方在于三点
[card:key-points items="数据库驱动,模板生态,多端同步"]
```

## Implementation Priority

1. Timeline markup engine + timeline.json generation (core)
2. HTML knowledge card templates + rendering (core)
3. Provider interfaces (core)
4. Web UI asset panel (core)
5. TTS provider implementation (studio)
6. Puppeteer screenshot for cards (studio)
7. FFmpeg local compositor (studio)
8. Jianying exporter (studio)
9. Cloud compositor (studio, Pro)
10. AI video generation providers (studio)
