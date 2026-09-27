# Handover · Retro → writing loop (2026-09-27)

For: Codex. From: the Claude session that did the work. Design card: [editorial-experiments-design.md](editorial-experiments-design.md) (see its 2026-09-27 revision).

## Why this happened

The founder asked whether platform data and retros actually shape new scripts. The audit said no:

- The only learning that reached the writer pack was `creator-profile.json`.
- Your first monthly retro (`retro-monthly-2026-09-26T121500.md`) and its 3 hypotheses and 3 experiments stayed in `~/.autocrew`. The active library at `~/AutoCrew资料库/workspaces/default` had no `outcomes.jsonl`, no `hypotheses.jsonl`, no reports and no experiments file.
- Nothing wrote `editorial-experiments.json`. It was copied into place by hand.
- The experiments were bound to 3 topicIds that don't exist in the new library, so they matched zero new drafts.
- Hypotheses never gained `contentIds`, so the judge could never rule on them ("假设未绑定试验稿").

## What changed (code, merged to main)

| Change | Where |
|---|---|
| `topicIds` is now optional or empty, meaning a **platform-wide** experiment. Topic-specific experiments beat platform-wide ones. Two matches on the same tier still throw. | `src/modules/retro/editorial-experiments.ts` `readEditorialExperiments` / `selectEditorialExperiment` |
| After the ledger is written, the retro turns each new hypothesis into a platform-wide experiment: 21 days, one per platform per run. It deactivates the previous platform-wide experiment on the same platform. Skips (no platform, tag scope, no nextAction, over length) and write errors are appended to the report. They are not silent. | `deriveRetroExperiments`, `recordRetroExperiments`; `retro.ts` `linkExperiments` / `experimentNote`; `RetroResult.experiments` |
| `buildWritingContext` returns the `experiment` it injected. When the host pack is prepared, the content id is appended to that hypothesis's `contentIds`. Only open hypotheses are bound, only once, and serialized with the ledger writes. A failure only warns. | `generate-script.ts`, `writer-prepare.ts` `prepare()`, `hypotheses.ts` `bindContentToHypothesis` |

Tests: `src/modules/retro/*.test.ts` (96 pass) and `src/tools/writer.test.ts` (the new "本稿用到复盘实验" case). Full suite: 5300 pass. The one failing file is `frontend/src/revision.test.ts`, only because that worktree has no frontend `node_modules`.

## Data already moved (copy only; `~/.autocrew` untouched)

- `outcomes.jsonl` (35 lines) and `hypotheses.jsonl` (3 open) → `~/AutoCrew资料库/workspaces/default/`
- `reports/retro-monthly-2026-09-26T121500.md`, `reports/first-month-2026-09-26/`, `reports/account-insights/` → the workspace `reports/`
- `editorial-experiments.pending.json` is in the workspace. It holds your 3 experiments with `topicIds: []`, still expiring 2026-10-15, and was checked with the new code: douyin, wechat_video and xiaohongshu each resolve to one experiment, and bilibili resolves to none.

## Your steps, in order

1. **Restart the :4317 daemon on the new main.** The main checkout has uncommitted handoff-P6.1 edits from another session (`src/modules/video/handoff/*`, `skills/publish-content/*`). A restart puts them live as well, so confirm with the founder or land them first.
2. **Only after the restart**, rename `editorial-experiments.pending.json` to `editorial-experiments.json`. The old code rejects empty `topicIds` and would fail **every** writer pack.
3. Check that the next douyin pack's `writingContract` contains `exp-20260926-douyin-opening`, and that `hypotheses.jsonl` gains a line binding that content id to `hyp-20260926-opening-douyin`.

## Known gaps (not done here)

- **Outcomes → content id.** The judge needs outcomes keyed by `contentId`. Most CSV rows have `contentId: null`. Bound drafts only become judgeable once published items are registered with their AutoCrew content id plus the platform id. That belongs to metrics autopull/registration.
- **Internal engine writer path** (`generate-script.ts` around line 953, the non-host path) injects the experiment but doesn't bind. The host pack is the main path.
- **Library "create" flow.** It didn't carry account-level files (`outcomes`, `hypotheses`, `reports`, experiments) from `~/.autocrew`. They are account history, not old drafts. Another user creating a library will lose them the same way.
- **Graduation.** A hypothesis the code judges `supported` still doesn't become a permanent writing rule. Per the founder's rule "learning is automatic, the human only audits", that is the next step, but the sample sizes are too small for it to matter yet.
- `STYLE.md` and `~/.autocrew/MEMORY.md` are read by nothing on the writing path. The `autocrew_memory` tool is not registered. Leave them, or delete them in a cleanup pass.

## Next up (founder-approved, not started)

Split the library into a human "我的内容" view and a hidden AI workspace:

- Stage columns: 写稿中 (MD kept) / 待录制 / 剪辑中 / 待发布 / 已发布 / 复盘.
- Human-side files are hard links, so they can be dragged straight into platform upload pages.
- Each video gets an empty folder before export, and the founder drops the final cut into it.
- The voiceover script stays reachable during editing.
- Only the latest 3–5 published items stay locally. The rest are archived to the NAS.

## Update (later 2026-09-27): 我的内容 view + 实拍版 — live on main (58ea245), daemon restarted

What changes for Codex:

- **`autocrew_video register` now requires `srt_path` for video platforms.** Pass the subtitle file of the final cut, inside the project, as an absolute path. Missing → `invalid_params` with `which: "srt_path"`. Unparseable → `srt_invalid`. The handoff bundle's register template already lists it.
- On register, AutoCrew rebuilds the spoken text from that SRT into `01-script/spoken/gNNNN-spoken.md`, and records a script → spoken contrast pair that the writer learns from.
- If saving the spoken version fails after the final cut is registered, the receipt carries a `warning`. Surface it; don't retry the register.
- **The founder exports finished cuts into `07-delivery/export/`.** The "成片放这里" folder in the view points there. `PROJECT_RULES` says so, but existing projects' `AGENTS.md` weren't rewritten.
- **The founder's view** lives at `~/AutoCrew资料库/我的内容/` (1 写稿中 … 6 复盘).
  - The daemon reconciles it every 60s. Never write into it; it is a view.
  - Library-root entries other than `我的内容` are Finder-hidden (`chflags hidden`). Paths are unchanged.
- **Founder edits to `口播稿.md` under 1 写稿中 / 2 待录制 flow back as a new content version.** This is skipped while an AI claim is held, while a pack is preparing, after handoff, or when the AI changed the draft concurrently. Skipped edits are kept as `口播稿（我改过的 …）.md`.

Not done yet: NAS archive of published items (step 2; the founder confirms what gets deleted locally first).

The item registered before this change ("深度思考", publish_ready) has no 实拍版. If you want one, re-register it with `srt_path`. The founder hasn't asked for that.
