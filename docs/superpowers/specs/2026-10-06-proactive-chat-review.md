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

## Addendum 2026-10-06: agent asks (请示) are chat-decidable

First real run showed the most common pending item is an agent ask (e.g. Codex asking to approve a 12-group storyboard), which was web-only. Founder: asks can be answered in chat too.

- `ask` items become chat_decidable for every kind, including 分镜 and 花费 (the founder's own chat words are the answer; for 花费 the brief must state the amount/what is paid for verbatim from the ask).
- brief: who asks, the question verbatim, the options (numbered, labels verbatim), attachments. The agent relays; the founder answers with an option ("行"/"第 2 个") plus optional extra words (e.g. "第 3 组换成…"), stored as the answer note. A reply that doesn't map clearly to one option → the agent asks back, never guesses.
- decide: `answer_ask {item_id, gen, option_id, note?, founder_words, request_id}` through the existing answer path (same CAS/consumption, source chat, founder_words stored). Storyboard asks keep their commit-time validation (settle window, identity checks) — refusal is surfaced.
- attachments: images go to the file pane via preview_dir. HTML review pages reference relative media, so copying the html alone breaks it: open the original html in the default browser (injectable opener) and also return its absolute path; say which happened.
- attachments changed since the ask → only `ask_resend` ("让 X 重发") is offered in chat.
- Existing agent_reported answers and their undo window are unchanged; a chat answer is recorded as a founder answer with source chat, not as agent_reported.

## Addendum 2026-10-06 (2): pre-publish checks (发之前再看一眼) in chat

Founder-confirmed. `publish_check` items become chat-decidable. Post-publish items (publish_claim, published_ask) stay web-only.

- brief per platform item: the plan entry verbatim — post title, caption, hashtags, cover text, scheduled time (with timezone); cover files into preview_dir; the final cut's absolute path; the check results grouped as passed / unchecked / blocked with each blocked reason verbatim.
- decisions: `publish_check_confirm` ("没问题"; not offered when blocked), `publish_check_revise` (note required = founder's words, relayed to the agent to fix), `publish_check_override` (only when blocked; founder_words required and stored verbatim).
- "都没问题" across several listed platform items: the agent may decide each listed item separately with the same founder quote; if the founder names specific platforms, only those. Each decide is its own request with its own gen check. Tool description must say this explicitly and forbid extending it to items not shown in the same list.
- guards: gen change (title/caption/files changed after viewing) → stale + fresh item; confirm runs the fresh publish-time verification (commitSha on every file in the package, unsettled files refused) and surfaces refusals; already decided → already_handled; web flow unchanged; source chat with founder_words, request_id recovery as for other chat decisions.
