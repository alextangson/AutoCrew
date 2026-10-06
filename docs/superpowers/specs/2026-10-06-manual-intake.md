# Manual intake instead of automatic discovery

Status: founder-confirmed 2026-10-06. Supersedes the fs-watch plan (parked on branch feature/fs-watch).

The founder tells the agent when they drop footage ("原片放进去了，是《XX》那条"); Codex registers its own outputs. Automatic discovery (listening to inbox videos, transcript matching, scanning download / ChatCut / 剪映 export folders) is removed. Fewer moving parts, no false "没对上" alerts, near-zero idle cost.

## Rules

1. Inbox (我的内容/0 原片放这里): no automatic matching, transcription, or "没对上" items. New chat path: the agent lists inbox files on request and attaches one to a named content (`autocrew_review_inbox` or the most fitting existing tool — e.g. actions `inbox_list` / `inbox_attach {file, content_id, founder_words}`), reusing the existing founder attach path (attach_aroll / assign semantics, sha guard, move into project, ChatCut-reference hold). Ambiguous file or content → the agent asks; never guesses.
2. Download / ChatCut / 剪映 export folders: no automatic scanning. Codex records its deliverables (existing record path). Founder's own exports: tell the agent, which records them through the same intake path.
3. Safety sweep only: on startup and every 30 minutes (replacing the 60s tick in desktop/server.ts), covering project folders (replaced/deleted files, registrations) and syncing founder edits in 我的内容 back. A chat/tool action "同步一下" runs the sweep immediately (single-flight).
4. Delete code that exists only for automatic discovery — inbox auto-move/auto-attach, transcript matching queue, watch-folder scanning, export-dir scanning, their report fields and inbox item types — no flags. Keep anything still used by the manual path.
5. Existing data stays valid: already auto-attached arolls, existing candidates and decisions keep working; nothing new is produced by discovery.
6. Settings: remove the 监视文件夹 option (UI + settings schema/readers). Old settings files containing it must still load (ignore the field).

## Acceptance

- Idle server does no discovery work; sweep cadence 30 min + startup; "同步一下" triggers it.
- Chat intake: list inbox files; attach named file to named content; ambiguous → refusal with candidates; file changed since listing → refused (sha); ChatCut-referenced inbox file handled as today.
- No "没对上" / auto-attach items appear anymore; existing ones from old reports don't crash readers.
- Old settings with watch folders load fine; UI no longer shows the option.
- `npm run check` green; doctor/self-checks don't reference removed pieces.
