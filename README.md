# AutoCrew

AI content operations crew — automated research, writing, and publishing pipeline for Chinese social media.

AutoCrew is a plugin that works with both **OpenClaw** and **Claude Code**, giving your AI agent the ability to research topics, write platform-optimized content, and manage a content pipeline — all locally, no server required.

## Integration Direction

AutoCrew is evolving by extracting workflows that are already proven inside local OpenClaw setups, rather than rebuilding everything from scratch.

Near-term integration priorities:

- WeChat MP draft publishing
- short-video platform-native rewriting
- Chinese de-AI / humanizer stage
- XHS cover generation + human approval loop

Implementation blueprint:

- [OpenClaw Integration Blueprint](./docs/openclaw-integration-blueprint.md)
- [Browser-First Research Strategy](./docs/browser-first-research.md)

## Research Model

AutoCrew is moving to a **browser-first** model:

- use the user's own logged-in browser session first
- use API providers like TikHub only as fallback
- keep research and publish flows close to the user's real account context

By default the browser adapter looks for a CDP proxy at `http://127.0.0.1:3456`.
Set `AUTOCREW_CDP_PROXY_URL` if your proxy runs elsewhere.

## Install

### OpenClaw

```bash
openclaw plugins install autocrew
# or link locally for development:
openclaw plugins install --link ./path/to/autocrew
```

### Claude Code

```bash
claude --plugin-dir ./path/to/autocrew
# or install permanently:
claude plugin install autocrew
```

## What It Does

| Skill | Description |
|-------|-------------|
| `research` | Competitor analysis and topic discovery |
| `topic-ideas` | Interactive brainstorming from a seed idea |
| `spawn-planner` | Batch topic planning for a content calendar |
| `write-script` | Write platform-optimized content (XHS, Douyin, WeChat) |
| `spawn-writer` | Single content writing orchestrator |
| `spawn-batch-writer` | Batch content production from saved topics |
| `publish-content` | Pre-publish checks + browser automation (XHS, Douyin, WeChat Video, WeChat MP) |
| `manage-pipeline` | Set up automated pipelines (cron schedules) |
| `memory-distill` | Learn from user feedback to improve over time |
| `style-calibration` | Analyze and match user's brand voice |

## Tools

| Tool | Description |
|------|-------------|
| `autocrew_topic` | Create/list content topics |
| `autocrew_research` | Browser-first topic discovery and session readiness checks |
| `autocrew_content` | Save/list/get/update content drafts |
| `autocrew_asset` | Manage assets (covers, B-Roll, videos, subtitles) and version history |
| `autocrew_pipeline` | Create/manage automated pipelines (cron schedules, templates) |
| `autocrew_publish` | Run publishing flows such as WeChat MP draft push |
| `autocrew_humanize` | Run the Chinese de-AI pass on raw text or saved drafts |
| `autocrew_rewrite` | Create platform-native rewrites from an existing draft |
| `autocrew_cover_review` | Create and approve Xiaohongshu A/B/C cover review candidates |
| `autocrew_memory` | Capture user feedback into MEMORY.md and read current memory |
| `autocrew_status` | Pipeline status overview |

## Data Storage

All data is stored locally at `~/.autocrew/`:

```
~/.autocrew/
├── topics/                      # Topic ideas (JSON files)
├── contents/
│   └── content-xxx/             # Each content is a project directory
│       ├── meta.json            # Metadata, asset index, version index
│       ├── draft.md             # Current body as readable markdown
│       ├── assets/              # Media files
│       │   ├── cover.jpg        # Cover image
│       │   ├── broll-01.mp4     # B-Roll clips
│       │   └── subtitle.srt     # Subtitles
│       └── versions/            # Version history
│           ├── v1.md            # Initial draft
│           ├── v2.md            # After first edit
│           └── v3.md            # After revert/rewrite
├── MEMORY.md                    # Learned preferences
└── STYLE.md                     # Brand voice profile
```

## CLI (OpenClaw only)

```bash
openclaw crew status               # Pipeline overview
openclaw crew research --keyword "AI 编程" --platform xiaohongshu
openclaw crew sessions
openclaw crew topics               # List saved topics
openclaw crew contents             # List content drafts (with asset/version counts)
openclaw crew assets <content-id>  # List assets for a content project
openclaw crew versions <content-id># Show version history
openclaw crew open <content-id>    # Show project directory path
openclaw crew pipelines            # List configured pipelines
openclaw crew templates            # Show preset pipeline templates
openclaw crew wechat-mp-draft <article-path> [--dry-run]
openclaw crew humanize <content-id>
openclaw crew adapt <content-id> <platform>
openclaw crew cover-review <content-id>
openclaw crew approve-cover <content-id> <a|b|c>
openclaw crew learn <content-id> --signal edit --feedback "太正式了"
openclaw crew memory
```

## Quick Start

```
You: "帮我调研 AI 工具赛道，找 10 个小红书选题"
Agent: (uses research skill → saves topics via autocrew_topic tool)

You: "把这些选题都写成小红书笔记"
Agent: (uses spawn-writer skill → saves drafts via autocrew_content tool)

You: "第 3 篇太正式了，改成更口语化的风格"
Agent: (rewrites + memory-distill learns the preference)
```

## Development

```bash
git clone https://github.com/alextangson/AutoCrew.git
cd AutoCrew
npm install

# Test with OpenClaw (link mode)
openclaw plugins install --link .

# Test with Claude Code
claude --plugin-dir .
```

## License

MIT
