# AutoCrew

AI content operations crew — automated research, writing, and publishing pipeline for Chinese social media.

AutoCrew is a plugin that works with both **OpenClaw** and **Claude Code**, giving your AI agent the ability to research topics, write platform-optimized content, and manage a content pipeline — all locally, no server required.

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
| `autocrew_content` | Save/list/get/update content drafts |
| `autocrew_asset` | Manage assets (covers, B-Roll, videos, subtitles) and version history |
| `autocrew_pipeline` | Create/manage automated pipelines (cron schedules, templates) |
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
openclaw crew topics               # List saved topics
openclaw crew contents             # List content drafts (with asset/version counts)
openclaw crew assets <content-id>  # List assets for a content project
openclaw crew versions <content-id># Show version history
openclaw crew open <content-id>    # Show project directory path
openclaw crew pipelines            # List configured pipelines
openclaw crew templates            # Show preset pipeline templates
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
