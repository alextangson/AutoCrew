# Handover to Codex — 2026-10-03

You're picking up AutoCrew (work from the main checkout; read `AGENTS.md` first) after the 0.5.0 release. Two jobs, in this order: review what shipped, then rewrite your own host adapter. Report to the founder in Chinese; code, commits and adapter files stay English unless the file is already Chinese.

## State you're inheriting

- `v0.5.0` is tagged and released on GitHub (commit `57403f78`, CI green on Node ≥ 22.19). Local `main` = `origin/main`. Tags are never re-pointed — a fix is 0.5.1.
- 0.5.0 = four features, all built by Claude and reviewed **only by independent Claude reviewers** (Codex had no credits):
  - **A-roll auto-match** (ontology 1b) — spec `docs/superpowers/specs/2026-09-30-ontology-1b.md`. Inbox + watch folders (the founder's `~/Downloads` is on, with auto-move), L1 filename + L2 transcript match (floor 0.30, margin 0.20), match job queue, ChatCut path-reference guard.
  - **「等你拍板」 review inbox** (2a) — spec `docs/superpowers/specs/2026-09-30-review-inbox.md`. One list of founder decisions; `autocrew_content ask / answer_ask / withdraw_ask / mark_ready`, `record` with `review=true`, cover pairs via `paths` / `pair_with`.
  - **One-click update** — spec `docs/superpowers/specs/2026-10-01-self-update.md`. 17 review rounds + 3 real e2e runs; reports in `~/.cache/autocrew-yt/self-update/` (`claude-review-*.md`, `e2e-1002{,b,c}.md`).
  - **Onboarding + one-click connect** — spec `docs/superpowers/specs/2026-10-02-onboarding-connect.md`. `autocrew connect claude|codex|workbuddy`; host parity: every named host (claude-code, codex, workbuddy, dsh) has the same tools; only founder decisions (adopt, approve cut, accept draft, pick cover, "I published") are refused for any model caller (`mcp/host-policy.ts`, production decisions).
- Codex is **not connected** under the new flow: `node bin/autocrew.mjs connect --list` shows Codex 「没连上」 — the old `~/.codex/config.toml` entry predates `connect`.

## Job 1 — review 0.5.0

Diff: `git diff c8e409bc..v0.5.0` (large; ~170+ files). Review it as the second pair of eyes this release never got. Prior Claude reviews already covered a lot — read the latest report per area before re-reporting something, and verify anything you flag end to end against current code (no "might" findings).

Weight where a wrong answer costs the founder most:
1. A real file of the founder's gets moved, overwritten or lost (1b auto-move, watch folders, undo/reassign).
2. A founder-only decision can be made by an agent, or a stale/forged item gets decided (2a CAS, `item_id`/`gen`).
3. An update leaves an install broken or reports success it didn't earn; recovery steps that are unsafe for the disk state they're shown on.
4. `connect` corrupts or drops entries in someone's `~/.claude.json`, `~/.codex/config.toml`, `~/.workbuddy/mcp.json`; a token survives revoke or falls back to server-token when `AUTOCREW_HOST` is set.

Known and deliberately left (don't re-report unless you can show it's worse): cut / deep-research queues refusing an update were only verified by reading code; multi-interruption update combos listed as P3 in `claude-review-17-delta.md`; the interrupted-update record is per machine dir, not per checkout.

Output: findings ranked P1/P2/P3 with file:line, a concrete failing scenario, and a suggested fix, written to `~/.cache/autocrew-yt/codex-review-050.md`. Don't fix — the founder decides; fixes go out as 0.5.1 and Claude implements them.

## Job 2 — write your own adapter

`adapters/codex/` (`README.md`, `AGENTS.editor-writer.md`, `AGENTS.editor.md`, `AGENTS.cover.md`, installed via `autocrew host codex --dir … --role …`) was written when Codex was a restricted editing station. It's now stale and self-contradictory — e.g. `AGENTS.editor-writer.md` still carries the 「P6 起停用」 banner saying Codex may only edit. You know best what a Codex session needs to work AutoCrew well, so this one is yours: decide the shape (keep three personas, merge them, something else) and rewrite it.

What the adapter has to get right:
- **Parity is real now.** Codex can write, review, cover, cut and prepare publishing. The only refusals are the founder decisions above; the adapter must route those to 「等你拍板」 instead of trying them or asking in chat. Ground every capability claim in `mcp/host-policy.ts` and the tool contract (`mcp/__fixtures__/tool-contract.json`) — don't promise tools the codex host doesn't list (hidden tools like `autocrew_style`, `autocrew_humanize` aren't listed for named hosts).
- **The 0.5.0 flows**: ask the founder via `autocrew_content ask` (not in chat); `record` every artifact (A-roll, ChatCut project with `uses_aroll`, cut with `review=true` only when truly reviewable / `mark_ready`, SRT `for_cut`, covers as a 3:4+4:3 pair); A-roll `pending_match` → poll `summary` with `since_seq` no faster than every 30 s → import the accepted path, never the original download path.
- **Self-contained.** The adapter ships to other users. It can't depend on the founder's local skills (`~/.codex/skills/personal-ip-video-loop` etc.) or anything outside the repo. If something the founder's local skill does belongs in the product, say so in your report instead of referencing the local file.
- `autocrew host codex` must still install it idempotently (delimited block, append-or-replace). Keep its tests green; add tests for any behavior you change.
- Keep `codex exec` cancelling MCP calls without the bypass flag (openai/codex #24135) in the README — it's a real trap.

Connecting yourself: the founder agreed (2026-10-02) to `autocrew connect codex` on this machine replacing the old `config.toml` entry; the command backs up `config.toml` with a timestamped `.autocrew-bak-*` before writing. Run it once you're ready to test the adapter for real, and report the backup path. Don't touch `~/.claude.json` or WorkBuddy's config.

Work on a branch (`chore/codex-adapter` or similar), run `npm run check`, and stop before merging — report what you changed and why, and the founder signs off. Don't push.

## Ground rules on this machine

- Several sessions run at once. Don't use `git stash`, don't touch other worktrees, stage by path.
- Before restarting `:4317`, check nothing is running (active turns, update lock); the founder is using it.
- Tests must not touch `~/.autocrew`, `~/AutoCrew资料库`, the NAS, or real host configs.
- Scratch output goes under `~/.cache/autocrew-yt/`, not `/tmp`.
