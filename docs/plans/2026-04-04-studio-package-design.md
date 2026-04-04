# @autocrew/studio Package Design

## Problem

AutoCrew has a complete script-to-timeline pipeline (markup parser, card templates, provider interfaces, Web UI), but no actual asset generation or composition. Users can't go from timeline.json to a finished video or Jianying project file.

## Decision: Node.js Native (Single Stack)

Evaluated Python bridge approach (using pyJianYingDraft) vs Node.js native. Chose Node.js native because:

- Same stack as @autocrew/core — single language, single package manager
- Critical for open-source adoption: `npm install` vs npm + pip
- Jianying draft format is JSON — can implement minimal subset in TypeScript by referencing pyJianYingDraft
- Doubao TTS is HTTP API — language agnostic
- Long-term maintenance: one CI, one debugger, one type system

## Architecture

### Monorepo Structure (npm workspaces)

```
AutoCrew/
├── packages/
│   └── studio/
│       ├── src/
│       │   ├── providers/
│       │   │   ├── tts/doubao.ts
│       │   │   ├── screenshot/puppeteer.ts
│       │   │   └── compositor/
│       │   │       ├── ffmpeg.ts
│       │   │       └── jianying/
│       │   │           ├── exporter.ts
│       │   │           ├── draft.ts
│       │   │           └── types.ts
│       │   ├── pipeline/render.ts
│       │   ├── config/index.ts
│       │   └── index.ts
│       ├── tests/
│       ├── package.json
│       └── vitest.config.ts
├── package.json  ← workspace root
└── (existing core code stays in place, not moved yet)
```

Phase 1 does NOT move existing code into packages/core/. Studio references core via relative imports or workspace link.

### Provider Implementations

**TTS: Doubao (火山引擎)**
- Endpoint: `https://openspeech.bytedance.com/api/v1/tts`
- Auth: AppID + AccessToken
- Returns base64 mp3, decode and write to file
- Text limit: ~300 Chinese chars per request → auto-chunk long segments

**Screenshot: Puppeteer**
- Reuses core's `renderCard()` to generate HTML
- Puppeteer opens headless Chrome, sets viewport to aspect ratio dimensions, screenshots
- Output: PNG per card segment

**Compositor: FFmpeg**
- fluent-ffmpeg wrapper
- Combines TTS audio + visual assets (B-roll video / card PNG) + subtitles
- Output: mp4

**Compositor: Jianying Export**
- Generates draft_content.json in Jianying's format
- Minimal subset: video/audio/image/text tracks, segment timing, material references
- Time values in microseconds
- User opens resulting folder in Jianying

### Render Pipeline

```
Timeline (from core)
  → 1. TTS generation (parallel, all tts segments)
  → 2. Card screenshot (parallel, all card segments)
  → 3. Time calibration (replace estimated with actual TTS duration)
  → 4a. FFmpeg compose → mp4
  → 4b. Jianying export → draft folder
```

### Configuration

```json
// ~/.autocrew/studio.config.json
{
  "tts": {
    "provider": "doubao",
    "doubao": {
      "appId": "xxx",
      "accessToken": "xxx",
      "voiceType": "BV700_V2_streaming"
    }
  },
  "screenshot": { "provider": "puppeteer" },
  "compositor": {
    "provider": "jianying",
    "jianying": {
      "draftDir": "~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft"
    }
  }
}
```
