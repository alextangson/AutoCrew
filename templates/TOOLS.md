# Tools

## AutoCrew Plugin Tools

These tools are automatically available when AutoCrew is installed.

| Tool | Description |
|------|-------------|
| `autocrew_topic` | Create/list content topics. Actions: create, list |
| `autocrew_research` | Browser-first topic discovery and session readiness |
| `autocrew_content` | Save/list/get/update content drafts. Actions: save, list, get, update |
| `autocrew_asset` | Manage assets and versions. Actions: add, list, remove, versions, get_version, revert |
| `autocrew_publish` | Run publishing flows such as WeChat MP draft push |
| `autocrew_humanize` | Run the Chinese de-AI pass |
| `autocrew_rewrite` | Create platform-native rewrites. Actions: adapt_platform (single), batch_adapt (multi + auto title/hashtag + sibling) |
| `autocrew_pre_publish` | Pre-publish checklist gate: 6 checks before allowing publish |
| `autocrew_cover_review` | Manage Xiaohongshu A/B/C cover review |
| `autocrew_memory` | Capture user feedback into MEMORY.md |
| `autocrew_status` | Show pipeline status: topic count, content count, status breakdown |

## External Data APIs (optional)

| Service | Purpose | Config |
|---------|---------|--------|
| TikHub (`api.tikhub.dev`) | Xiaohongshu/Douyin competitor data | Set `tikhub_token` in plugin config |
| Web Search | Trending topics, keyword research | Built-in (no config needed) |

## Data Storage

All data stored locally at `~/.autocrew/`:

```
~/.autocrew/
├── topics/                      # Topic ideas (JSON)
├── contents/
│   └── content-xxx/             # Each content = a project directory
│       ├── meta.json            # Metadata + asset index + version index
│       ├── draft.md             # Current body as readable markdown
│       ├── assets/              # Media files (covers, B-Roll, videos, subtitles)
│       └── versions/            # Version history (v1.md, v2.md, ...)
├── memory/                      # Archived memory entries
├── MEMORY.md                    # Working memory (brand, audience, preferences)
└── STYLE.md                     # Brand voice profile
```
