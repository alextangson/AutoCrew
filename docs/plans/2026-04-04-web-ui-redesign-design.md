# AutoCrew Web UI Redesign

## Product Positioning

Content production platform for non-technical creators (bloggers, operators). Topic-driven, one-stop pipeline from discovery to multi-format publishing. Design language: Linear + Notion hybrid — kanban/list switchable main view, full-screen editor on click.

No emoji anywhere in the UI. Clean, premium, restrained.

## Core Flow

```
Discover topic → Select → AI generates content → Edit & adjust → Multi-format output → Publish
```

Users see "scripts" and "visuals", not "timelines" and "TTS segments".

## Navigation

Top bar, no sidebar. Four tabs + command palette + settings.

```
AutoCrew     Discover   Content   Publish               Cmd+K   Settings
```

| Tab | Purpose | Replaces |
|-----|---------|----------|
| Discover | Topic recommendations + search | Research page + Dashboard |
| Content | Kanban/list of all content, click to edit | Contents + AssetPanel + Workflows |
| Publish | Publishing status per platform | New |
| Settings | Account binding, AI config, preferences | New |

Dashboard and Workflows pages are removed. Dashboard adds no value with empty state. Workflows is a technical concept users don't need.

## Page 1: Discover

Card grid of trending topics. Each card shows: title, score, source platform, "Start Creating" action. Click "Start Creating" → creates content item, redirects to editor.

Sections: "Trending Today" with filter dropdown, "Recommended For You" based on domain preferences.

## Page 2: Content (Kanban + List)

### Kanban View (default)

Four columns: Topic → Creating → Ready → Published

Cards are draggable between columns. Each card shows:
- Title
- Score (topic column only)
- Format output status (e.g., "video done · article generating · wechat pending")
- Progress indicator

### List View

Table: Title, Status, Formats, Updated. Click row → editor.

## Page 2b: Full-Screen Editor (Core Page)

Three-column layout with split-pane editing:

### Left Column (200px): Format & Settings

- Output format switcher (video, xiaohongshu, wechat article)
  - Each format shows status with dot indicator (· ready, · generating, · pending)
  - Switching format changes center and right columns
- Video settings (when video format selected):
  - Voice: dropdown (Cancan 2.0, etc.)
  - Aspect ratio: 9:16, 16:9, 3:4, 1:1, 4:3
  - Style: knowledge-explainer, tutorial

### Center Column: Script Editor

- Editable plain text textarea
- Paragraphs separated by dashed dividers
- Visual markers between paragraphs as read-only tags: `[comparison table]`, `[B-roll: office scene]`
- Cursor position in a paragraph → right column shows corresponding visual
- Editing text marks that paragraph as "needs regeneration"
- No rich text, no block editor — pure text with inline tags

### Right Column: Visual Preview

- Shows the visual asset for the currently focused paragraph
- Card screenshot or B-roll video player
- Status label (ready / generating / pending / failed)
- Action links (plain text, not buttons):
  - Regenerate
  - Edit prompt
  - Upload replacement
- Audio player at bottom:
  - Text preview of the narration
  - Playback scrubber with timecode

### Bottom Bar

- Progress: "8/12 segments ready"
- Actions: "Confirm All", "Export to Jianying", "Generate Video"

## Page 3: Publish

List of content items with expandable platform rows.

Each content item shows all formats, each format shows target platforms with:
- Status (published / publishing / pending / failed)
- Metrics after publishing (views, likes)
- "Publish" action per platform
- "Publish All" bulk action per content

Tabs: Pending · Published · Failed

## Page 4: Settings

- Platform account binding (Douyin, Xiaohongshu, Bilibili, WeChat)
- AI configuration (voice, default ratio, style preference)
- Doubao API Key
- Jianying export path

## Design Language

| Element | Choice | Rationale |
|---------|--------|-----------|
| Icons | No emoji. Use SVG icons or plain text | Premium, clean |
| Layout | Top nav + full-width content | Modern, no wasted space |
| Theme | Dark, improve contrast from current | Long sessions, eye comfort |
| Status | Small dot · or text label | Minimal, scannable |
| Buttons | Text links for secondary, filled for primary | Hierarchy without clutter |
| Spacing | Generous whitespace | Breathable, premium feel |
| Motion | Slide transitions, subtle hover lifts | Polished but not flashy |
| Fonts | Keep current Chinese-first stack | OK |
| Components | Lightweight custom, no heavy framework | Small bundle |

## Technical Changes

| Area | Current | Change |
|------|---------|--------|
| Router | 5 flat routes | 4 top-level + nested editor route |
| State | React Query | Keep, add zustand for editor state |
| Drag & drop | None | @dnd-kit/core for kanban |
| Editor | AssetPanel static | Split-pane textarea + preview sync |
| Command palette | None | cmdk (2KB) |
| CSS | Global CSS + inline mix | Unify on global CSS with dark variables |

## Backend API Changes

Mostly reuse existing endpoints. New ones needed:

| Endpoint | Purpose |
|----------|---------|
| PATCH /api/contents/:id/status | Move content between kanban columns |
| GET /api/discover/trending | Curated topic feed (wraps existing research) |
| POST /api/contents/:id/publish | Trigger publish to specific platform |
| GET /api/contents/:id/publish-status | Publishing status per platform |

## Mapping to Existing Code

| New UI Concept | Existing Backend |
|----------------|-----------------|
| Topic cards in Discover | autocrew_research tool |
| "Start Creating" | autocrew_pipeline workflow |
| Script editor | timeline.parser + markup-generator |
| Visual preview | VisualPreview component (reuse) |
| Paragraph cards | SegmentCard component (refactor) |
| Voice generation | @autocrew/studio DoubaoTTS |
| Export | @autocrew/studio JianyingExporter |
| Publish | publish module |
