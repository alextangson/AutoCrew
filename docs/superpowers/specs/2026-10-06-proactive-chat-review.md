# Proactive review in chat — tell the founder what to judge, bring it to them

Status: founder-confirmed 2026-10-06. Builds on chat-decided review items (`autocrew_review_inbox`, spec 2026-10-06-chat-approval-via-dialog.md, final Revision).

## Problem

The founder finds AutoCrew's review flow tedious and can't tell what they're supposed to judge: items say "封面做好了，挑一张" and wait in a web list. Goal: the agent brings each pending decision into the conversation, says exactly what to judge, shows the files in the Claude desktop file pane, and the founder answers in one line.

## 1. "要你判断" per item (server-generated)

`autocrew_review_inbox list` returns, per chat-decidable item, a server-built `brief` the agent relays as-is (the agent must not invent judging criteria):

- cover_pick (latest group only; older groups as a count line "还有 N 组"): effective cover text (or "没写封面字"); what to judge: big text readable at a glance, the founder looks natural; 3:4 and 4:3 files.
- cut_review (latest version only; older as a count): version number, duration, what changed vs the previous version from the editor's delivery notes if recorded, else "没写改了什么"; reminder to watch from start for wrong cuts, stutter, caption errors; the file.
- candidate: kind, file name; for aroll the opening sentence of its transcript if already available (never trigger transcription); question "是不是这条稿的原片/成片/封面".
- Reply hint: "回我「用」/「还要改：……」". With several items, numbered so the founder can answer "1 用，2 还要改：…".

## 2. Files into the session's file pane

The desktop file pane only opens files inside the session's folders. `list` (and a single-item variant) accepts `preview_dir` = the calling session's working directory. The server places the item's files under `<preview_dir>/review-preview/<short-title>/` and returns paths relative to `preview_dir`; the agent writes them as markdown links.

- Images: copy. Videos: hard link (no extra space); if hard link fails (cross-device), open with QuickTime via `open` and say so instead of copying gigabytes.
- Placement failure (disk full, permission, missing dir): visible reason + fallback `open` in Preview/QuickTime. Never skip silently.
- Cleanup: preview files for an item are removed once it's decided; anything under review-preview/ older than 7 days is removed on the next list. Only touch our own review-preview/ subtree.
- `review-preview/` goes into the repo `.gitignore`.
- Commit-time sha checks still guard decisions; a file replaced after preview → refuse and re-show (existing behavior).

## 3. When the agent brings items

- Session start: the existing SessionStart line ("AutoCrew 待办…", produced via bin/autocrew.mjs / src/tools/desk.ts) instructs the agent, when there are chat-decidable items, to open its first reply by listing them via `list` with `preview_dir`. Nothing pending → say nothing about it.
- Video session: in `skills/video-session/SKILL.md`, when Codex finishes a cover or cut for this video, the agent immediately calls `list` for this content and presents the items.
- Codex host sessions do not push (it's the worker); deciding from Codex still works.

## Edges (acceptance list)

- E1 No pending items → no mention at session start.
- E2 Multi-group / multi-version → only latest previewed; count line for the rest; on request the agent can preview a named older group/version.
- E3 Preview placement failure → visible reason + open fallback.
- E4 File replaced after preview → decision refused, fresh item returned (existing sha guard).
- E5 Cleanup only within review-preview/; decided items' previews removed; 7-day sweep.
- E6 brief text is server-built; tests assert the per-type content and the "没写改了什么" / "没写封面字" fallbacks.
- E7 Web 等你拍板 unchanged.

## Non-goals

Inline images in the chat transcript (not supported by the client), batch decisions in one call, publish items in chat.
