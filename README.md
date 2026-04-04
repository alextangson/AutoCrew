# AutoCrew

**One-person content studio powered by AI — from trending topics to published posts.**

English | [中文](README_CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/autocrew.svg)](https://www.npmjs.com/package/autocrew)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

AutoCrew is an AI-powered content operations pipeline for Chinese social media. It handles the entire workflow — research trending topics, write platform-native drafts, review for sensitivity and AI-sounding language, and publish to Xiaohongshu, Douyin, WeChat, and more.

Works standalone as a CLI, or as a plugin for [Claude Code](https://claude.ai/code) and [OpenClaw](https://openclaw.dev).

```
You:       Find me topics for this week
AutoCrew:  (searches trending lists + scores by your niche → recommends 5 topics)

You:       Write #2 as a Xiaohongshu post
AutoCrew:  (generates draft in your voice → checks for sensitive words → outputs title options + hashtags)

You:       Too AI-sounding, make it more conversational
AutoCrew:  (de-AI pass → remembers your preference → applies automatically next time)

You:       Publish
AutoCrew:  (6-point pre-publish check → publishes)
```

---

## Quick Start

```bash
npm install -g autocrew
autocrew init
autocrew research
```

That's it. `init` creates your local data directory (`~/.autocrew/`), and `research` finds trending topics based on public sources (Zhihu, Weibo, industry keywords).

---

## Features

### Research
- Trending topic discovery from public sources (Zhihu Hot List, Weibo Trending, industry keywords)
- Topic scoring based on your niche and audience
- Intel pipeline for monitoring inspiration sources

### Write
- Style-calibrated drafts — 4-stage deep calibration learns your voice
- Hook-Body-CTA-Title structure optimized for Chinese social media
- Multi-platform rewrites (same topic, platform-native format)

### Review
- Sensitive word scanning (built-in + platform-specific throttled terms)
- De-AI-ification (去 AI 味) — removes robotic patterns from Chinese text
- Quality scoring: information density, hook strength, CTA clarity

### Publish
- Multi-platform: Xiaohongshu, Douyin, WeChat Video, WeChat Articles, Bilibili
- 6-point pre-publish checklist
- Cover image generation and A/B/C review

### Learn
- Auto-captures your edits as feedback
- After 5 similar corrections, distills them into writing rules
- Rules are applied automatically in future drafts

### Web Dashboard
- Built-in web UI for visual content management
- Script editor with timeline-based video production
- Jianying (剪映) export for video editing

---

## How It Works

AutoCrew runs entirely on your machine. All content, drafts, and creator profiles are stored locally in `~/.autocrew/`. No data is uploaded anywhere.

The core is a standalone Node.js CLI with 20+ tools and 15+ skills. A thin plugin layer lets it work as a Claude Code MCP server or OpenClaw extension — but it doesn't depend on either.

```
~/.autocrew/
├── creator-profile.json    # Your niche, audience, writing rules
├── STYLE.md                # Writing voice profile
├── topics/                 # Topic library
├── contents/               # Content projects
│   └── content-xxx/
│       ├── meta.json       # Metadata + status + asset index
│       ├── draft.md        # Current draft
│       ├── timeline.json   # Video timeline (if generated)
│       └── versions/       # Version history
└── learnings/              # Edit history + distilled rules
```

---

## Use with Claude Code

Add AutoCrew as an MCP server in your Claude Code settings:

```json
{
  "mcpServers": {
    "autocrew": {
      "command": "npx",
      "args": ["tsx", "/path/to/AutoCrew/mcp/server.ts"]
    }
  }
}
```

Then just talk to Claude naturally — "find me topics", "write this as a post", "make it less AI-sounding".

## Use with OpenClaw

```bash
openclaw plugins install autocrew
```

Works out of the box. All skills and tools are available in OpenClaw conversations.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `autocrew init` | Initialize data directory and creator profile |
| `autocrew status` | Pipeline overview |
| `autocrew research` | Discover trending topics |
| `autocrew topics` | List saved topics |
| `autocrew start <topic>` | Start a new content project |
| `autocrew contents` | List content items |
| `autocrew humanize <id>` | De-AI pass on a draft |
| `autocrew adapt <id> <platform>` | Platform-native rewrite |
| `autocrew review <id>` | Content review (sensitivity + quality) |
| `autocrew pre-publish <id>` | 6-point pre-publish checklist |
| `autocrew profile` | Show creator profile |
| `autocrew learn <id> --signal edit --feedback "too formal"` | Capture feedback |
| `autocrew intel` | Manage inspiration sources |

Run `autocrew --help` for the full command list.

---

## Free vs Pro

| Feature | Free | Pro |
|---------|------|-----|
| Topic research | Public search (Zhihu/Weibo) | + Competitor crawling + platform hot lists |
| Content writing | Full workflow | Full workflow |
| De-AI-ification | Yes | Yes |
| Sensitive word scan | Yes | Yes |
| Platform rewrite | Xiaohongshu + Douyin | + WeChat + Bilibili |
| Cover generation | 3:4 | + 16:9 + 4:3 |
| Publishing | Xiaohongshu + Douyin | All platforms |
| Style calibration | Yes | Yes |
| Learning loop | Yes | Yes |
| Competitor monitoring | No | Yes |
| Video ASR extraction | No | Yes |
| Analytics reports | No | Yes |

---

## Development

```bash
git clone https://github.com/alextangson/AutoCrew.git
cd AutoCrew
npm install
npm test        # 341 tests
```

Start the web dashboard in dev mode:

```bash
cd web && npm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT &copy; [alextangson](https://github.com/alextangson)
