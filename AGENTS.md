# AutoCrew — working in this repo

Instructions for any coding agent (Claude Code, Codex) developing AutoCrew. Product docs live in `README.md` and `docs/`; this file only holds what you would get wrong without it.

Note: `templates/AGENTS.md` is a product template shipped to end users' workspaces — it is not about developing this repo.

## Git: one worktree branch per task

Several sessions run on this machine at once, each in its own worktree under `.claude/worktrees/`, and local `main` is shared by all of them.

- Work on your worktree's branch; don't commit on `main` directly and don't touch other worktrees.
- Merge into `main` only after `npm run check` passes and the founder has signed off.
- Push only when the founder asks. Local `main` usually carries other sessions' unpushed commits, so run `git log --oneline origin/main..main` first; if it contains commits that aren't yours, push only yours (cherry-pick onto a branch cut from `origin/main`, then fast-forward push) or ask.

## Verifying

- `npm run check` = typecheck + lint + vitest. `npm run smoke` for end-to-end.
- The local service runs on :4317 (`npm start` / `npm run restart`). `npm start` builds the frontend first; in a fresh worktree run `npm install` inside `frontend/` or it fails with a wall of TS7026 and never starts.
- Before restarting :4317, check that no agent turn is running (`~/.autocrew/chief-editor/runs.json` entries with `status: running`, or recent work events). A restart kills an in-progress draft the founder is using; if something is running, ask first.
- Some changes (e.g. pending editorial-experiment files) only take effect after a :4317 restart — say so when you hand over instead of reporting them as live.
- A memory or old doc claiming "fixed / landed" is not evidence; confirm with `git log --all -S '<key code>'` before building on it.

## Invariants the code relies on

- **Tool arguments from the model are not trusted to be well-typed.** The relay endpoint serializes array/object args into JSON strings, sometimes with unescaped inner quotes. Every tool must normalize (array → use; string → parse, repair stray quotes, retry) and only reject what truly can't be parsed. Never let a non-array fall into an empty-array branch — that silently drops real results and reports success.
- **Provider-specific wire quirks are declared in `makePiModel` (`src/engine/pi-wire.ts`).** Model calls go through the loopback observer (`src/engine/observer.ts`), so pi-ai only ever sees `127.0.0.1` and its per-URL provider detection never fires. Decide compat from the real upstream `baseUrl` plus model id. These bugs surface only on fallback endpoints, so add a regression test.
- **Image generation goes through the chain** (`resolveImageChain` + `generateImageViaChain` in `src/modules/publish/image-gen.ts`), which respects the configured order (Codex first). Don't call a relay directly.
- **Self-contained installs.** Anything a feature needs must ship in the repo (`vendor/`, `sidecars/`) and be checked by `autocrew doctor` — never depend on scripts that only exist on the founder's machine (e.g. `~/.openclaw`). Credentials come from env/settings; only `*.example.json` is committed.
- **External-call failures surface a visible state.** No quiet fallback when a model, network or subprocess call fails.

## Design taste

- Prefer the lowest rung that works: script → workflow → single agent → multi-agent. Split agents by context boundary, not by job title.
- Before finalizing a major architecture spec, get a Codex consult and fold each finding into the spec.
- Don't build progress dashboards or agent-activity panels — tried and removed.
- Long-lived scratch output (transcripts, audio, model weights) goes under `~/.cache/autocrew-yt/`, not `/tmp` — this machine reboots mid-session.
