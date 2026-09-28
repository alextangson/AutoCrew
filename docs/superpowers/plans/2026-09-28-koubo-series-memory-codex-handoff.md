# Codex handoff: koubo no-padding / series memory / rule approval

You are implementing the code side of `docs/superpowers/specs/2026-09-28-koubo-no-padding-series-memory.md` (v2, founder-approved 2026-09-28). The spec is the source of truth; read all of it first, including §8 (the review findings it absorbed — they explain *why* each constraint exists). This file only adds scope, boundaries and how to report back.

Work in this worktree on branch `feature/koubo-series-memory` (cut from `main` 4a8d3ad). Line numbers in the spec were taken from an older branch; re-locate each reference before editing.

## Scope

In: spec §3 A, B, D in full; §3 C's code skeleton only (technique catalog store with stable id+version, draft vs approved directories, read-only expand-by-id entry reachable by the host through MCP, `technique_ids` validation, angle-stage exposure of the catalog + series snapshot); §4 submit contract.

Out: writing technique card content (the host writes those; ship the store with an empty approved directory and one clearly-marked fixture card for tests only); changing the existing style-distiller's background model call; any change to already-recorded drafts; any migration that rewrites the founder's `creator-profile.json` beyond what §3 D's backward-compat rules allow.

## Boundaries that matter more than anything else

- **Rule approval is founder-only (spec §3 D, P1).** No code path reachable by a model — MCP tools, chat router, `user_confirmed` flags, `source:user_explicit` — may turn a pending rule active. Only a server-verifiable workbench action bound to rule id + revision + decision can. Add an automated test proving a model passing `user_confirmed:true` through every existing entry cannot activate a pending rule.
- Existing `disabled:true` rules must stay disabled after any migration; rules lacking `status` read as active; newly distilled rules are written explicitly as `pending`.
- No new backend model calls. Semantic duplicate judgment is the host reviewer's; the server only validates structure (snapshot id, referenced items belong to the snapshot, coverage complete).
- Length is a hint, never a gate failure and never charged to repair budget.
- `draft_hash` keeps its current meaning; add the separate review-context fingerprint instead.
- The library directory at `~/AutoCrew资料库` is live founder data. Tests use temp dirs only; do not run anything that writes there.

## Judgment calls you own

Data shapes, file layout, naming, how the snapshot staleness check is made atomic, how the workbench approval event is authenticated. Prefer extending existing modules (`review_desk`, profile store, pattern store conventions) over new services. Where the spec is ambiguous, pick the reading that best serves "no padding, no cross-script repetition, founder controls rules", record the decision in a short `## Implementation notes` section appended to the spec, and continue — stop to ask only if the choice is irreversible for founder data.

## Done means

- `npm run check` passes (typecheck + lint + tests).
- New tests cover: attempt idempotency with the new fields; stale-snapshot re-review; pending rules excluded from every writing path including selection rewrite; pack fingerprint unchanged by a new pending rule; gap-record resume via `pack_request_changed → force`; the founder-only approval test above; old packs without `outline` still submit.
- Commits: English, `<type>: <why>` style, staged by explicit path (a hook blocks `git add -A` / `git add .`). Do not push, do not merge to main.
- Final message: what shipped per spec section, anything deferred or deviated (with reason), and the exact commands you ran with their results.
