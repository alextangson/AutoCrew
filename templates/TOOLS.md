# Tools

## AutoCrew Plugin Tools

These tools are automatically available when AutoCrew is installed.

| Tool | Description |
|------|-------------|
| `autocrew_topic` | Create/list content topics. Actions: create, list |
| `autocrew_content` | Save/list/get/update content drafts. Actions: save, list, get, update |
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
├── topics/          # Topic ideas (JSON)
├── contents/        # Content drafts (JSON)
├── memory/          # Archived memory entries
├── MEMORY.md        # Working memory (brand, audience, preferences)
└── STYLE.md         # Brand voice profile
```
