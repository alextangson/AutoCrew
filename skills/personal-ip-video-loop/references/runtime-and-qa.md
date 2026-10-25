# Durable loop and final QA

## State is a ledger, not a conversation guess

Keep workflow-state.json private under project notes. Persist before remote writes and after observed events. Record project/timeline IDs, exact source/SRT hashes, gate evidence, phase, next action, receipt paths, requests, poll times and artifact/QC results. Never put credentials or signed URLs in shared reports.

Each job contains `id, kind, provider, receipt_path, request_id, state, next_poll_at` and ordered `required_steps` drawn from `retrieved, downloaded, qc, imported`. `imported` means present in the editor media bin only. Timeline placement and final packaging are separate evidence under [assembly-evidence.md](assembly-evidence.md), not an implication of that flag. Set each completed step only after its actual evidence is saved. Export usually requires retrieval/download/QC, not import; B-roll requires all four.

Keep failed jobs in history. After a retry actually succeeds and passes QC, attach `resolution: {kind: retried, successor_id, evidence_path}` to the failed job. An approved editorial fallback instead uses `{kind: fallback, authorization_id, evidence_path}`. Do not hide unresolved jobs by deleting them.

While a retry is still processing, link the failed job's `retry_successor_id` to that later recorded job. Recovery follows the existing successor; it must not submit yet another attempt because the original failed. After checked completion, replace that temporary link with the evidenced resolution.

On resume:

1. Run the read-only state auditor. Validate local artifact hashes through lifecycle/H3 guards.
2. Reconcile submission intents with existing receipts first. A missing ID/timeout is unknown, not failed.
3. Query known provider jobs with their exact provider/endpoint/ID; finish retrieval and downstream work.
4. Re-read ChatCut structure before changing a timeline. Do not duplicate imported media/items after a lost reply; compare actual asset IDs and source ranges.
5. Continue the current phase until the next shown review gate or real blocker.
6. When `archive.requested` records the user's project-specific archive request, follow the lifecycle archive-and-cleanup reference. `archive` and `cleanup` are supported phases. Preserve the exact request and mode, NAS checksum/restore evidence and separate local/browser cleanup status. A partial cleanup must remain resumable; missing or blocked browser cleanup cannot become `complete`. `backup_only` is the default for “归档” and completes after verified backup without deletion; `archive_and_cleanup` only follows an explicit 清本地 request. The auditor is read-only and its next-action label is not evidence that a mount, media hash or browser operation is safe.

Internal QC records, hashes and boolean flags are evidence pointers, not independent proof. The auditor checks consistency, not the truth of a user quote, image meaning, audio quality or live state. Never auto-populate passed flags.

## Monitoring truth

Same-turn bounded polling continues automatically; cap individual waits at 60 seconds and avoid unchanged chatter. If work must continue after the turn, use the host's actual recurring-task/heartbeat mechanism when the user has requested follow-up/monitoring. Save its returned ID. No installed Skill alone provides a webhook.

Distinguish `same_turn_polling`, `host_heartbeat`, `provider_webhook` and `none`. Claim a provider webhook only after its registration and receiver are verified. With no usable background mechanism, persist state and disclose that automatic wake-up is unavailable; do not promise continued observation.

## Whole-project spend and bounded repair

The cash budget covers separately billed storyboard images, H3, music, SFX, API covers and other paid operations, not Codex subscription generation. In `spend`, record one entry per paid logical operation with `id, category, amount, currency, state, authorization_id`; states are reserved, committed, settled or void. Unknown paid submissions stay committed at worst-case amount. Replace the same entry's reserve with actual settled charge; do not add both.

For built-in subscription generation, keep a separate `quota_usage` entry with `id, category, runtime, billing_mode, model_requested, model_reported, generation_count, request_or_receipt, output_paths, state, limit_status`. Use `runtime="codex_builtin_image_gen"`, `billing_mode="codex_subscription"`; counts are observed calls, not invented tokens or cash equivalents. Unknown model/quota values stay null/unknown. A missing cash cap must not block subscription covers, and an API quote/key is not their prerequisite. Actual quota exhaustion or capability errors must be reported without buying credits, switching accounts or routing to paid API. Reuse outputs and fix identified defects; do not interpret subscription access as unlimited generation.

Use a stable project budget ID. Store amendments and exact consent separately while preserving prior charges/reservations. Do not reset the ledger, consumed attempts or liabilities after renaming a version. A change in currency needs current evidenced conversion; do not add CNY and USD.

Before each new paid action, compare existing commitments plus its worst case against category and total caps. For H3, use the shared local price estimates without routine live-price checks; “worst case” means all authorized attempts at the reference rates, not a guaranteed invoice maximum. Estimate-only values are not caps enforced by the provider. Include provider pricing conditions, fees and retry reserve; stop if the maximum cannot be bounded.

Reuse downloaded/licensed assets first. Retry only for authorized objective failures, not subjective novelty. H3 guard enforces exact request scope and prior terminal/QC evidence; other providers still require equivalent operator checks. Paid retries are never authorized merely by an internal QC failure.

## Audio sourcing and mix evidence

### Ownership and process (user confirmed 2026-09-29, replaces the 2026-09-27 Codex-only rule)

The session doing the edit — Claude or Codex — acts as 配乐音效师 per [sound-design.md](sound-design.md): content-specific cue sheet → user review of the sheet → sourcing, placement and measurement → 配乐审核 by a fresh Claude subagent per [sound-review.md](sound-review.md) → the user listens. The cue-sheet review is the user's one audio decision point; do not add a separate music-audition gate on top of it. ChatCut Desktop is the default editor and review surface. Do not delegate music or SFX selection, automatic matching, placement, or mix decisions to Jianying Agent. Use direct editor controls or verified timeline APIs for insertion; a control limitation must be reported rather than routed back to the Agent.

Do not pick a generic tense electronic bed merely because the narration discusses AI. Base instrumentation, energy, silence and changes on the argument and spoken density. Do not replace rejected music with procedural tones solely to avoid sourcing; any original local composition must be identified as such and judged as music. Keep the rejected bed recoverable, and replace it only with the selected candidate after verifying timing and editability.

Use the user's musical references as mood/arrangement references, not proof of a license or permission to download a commercial recording. Choose actual rights-suitable project/library assets or generate within the approved model/budget. Preserve provenance and usage evidence. Do not infer royalty-free rights from availability in a search result.

Select tracks by speech density and the cue sheet's section moods. Missing rights or an unapproved cost means choose an authorized alternative or report the blocker.

### Arrange the complete soundtrack before insertion

Genre tags are candidate filters, not listening evidence. Compare the actual groove, vocal content, arrangement density, breakdowns and ending against the narration. For rhythmic electronic music, preserve a coherent pulse without letting a busy lead or festival-style drop compete with speech. If the user rejects the musical foundation, restart source selection and arrangement; keep the rejected version recoverable instead of presenting another fade adjustment as new music.

Build a full-length, timeline-aligned music arrangement before import. Change cues on the argument's real turning lines (per the cue sheet), not on every chapter heading. Within a cue prefer continuous musical phrases with deliberate energy changes; choose compatible phrase/beat positions when extending or changing tracks. Crossfade length depends on the recording and phrase structure, not a universal number of seconds. Control bass and kick handover so overlapping parts do not create competing drum patterns. Use reduced level or arrangement thinning for emphasis; use silence only as a short intentional stop (about 1–2.5 s; longer reads as dead air). Design the opening and ending as part of the same arrangement.

Retain originals, license evidence, source in/out points, gain envelopes and an editable build or edit map. Keep BGM and SFX separately editable. Audit existing effects before adding any: a transition should not receive both a baked-in effect and a duplicate native effect. Keep music-only stems internal where the source license permits video use but forbids standalone music distribution. Label amplified solo audition files clearly and never place them as the final mix.

Before replacing music, read the user's current native timeline, preserve a lightweight recovery snapshot and replace the existing bed once. Verify the resulting start, duration, speed, gain and number of active music clips. An import receipt is not placement evidence. Waveform alignment, tempo estimates, silence scans and loudness measurements are technical checks; they do not establish musical phrasing, absence of vocals, pleasant transitions or an acceptable narration mix. Record unheard intervals explicitly and do not mark listening as passed from those checks.

Use verified ChatCut audio capabilities: speech anchor and music follower/ducking where supported; SFX event-linked and sparse. Begin conservatively: compare speech-active loudness, with music 12 LU below speech during talking, short-term LUFS per cue section, each section 10.5–13.5 LU (see sound-design.md). Distinguish gain settings from measured loudness.

Listen to the rendered mix at ordinary playback level across the opening, densest speech, quietest delivery, transitions, humor and ending. Check music masking, ducking pumping, cut clicks, SFX peaks and abrupt cue loops. Measure clipping/true peak when tools support it; document actual readings and measurement method, not imagined LUFS. One complete normal-speed pass of the final program is preferred; if not possible, list exactly which intervals/audio checks remain unverified.

## A-roll, text and motion

For deterministic presentation/explainer scenes, compare actual composed pixels with [explainer-packaging.md](explainer-packaging.md)'s Chatterfly reference. Verify layout, typography, paper cards and script-specific causal animation, not palette alone. Keep this visual-layer check distinct from native subtitle styling.

Inspect source frames before grading. Correct exposure/white balance, preserve skin, avoid excessive sharpening halos and crushed shadows; compare representative shots after applying a shared treatment. New detail cannot be recovered by declaring an “HD” filter.

For narration captions and keyword packaging, follow [subtitle-packaging.md](subtitle-packaging.md): resolve the actual 剪映新青年体, disable outline including inherited template/character strokes, and use a soft shadow. Check both native properties and composed pixels over A-roll and bright/complex B-roll; font loading or an SRT alone is not style proof. Preserve short phrases, safe areas and editable native captions. If the font is unavailable, report the gap and use only an already approved fallback; do not claim font parity.

Check generated and composed transitions continuously at normal speed, not only first/middle/last screenshots. Inspect the actual action, result hold and cut handles. Patch only the affected interval and recheck its neighbors. Broad self-scoring is optional, not another user gate.

## Export acceptance

Read back final timeline duration/items/audio routes. Track the exact export ID to completion, download and hash its file, decode the entire video when possible, and check video dimensions/FPS, audio presence, start/end, sync and subtitle timing. Compare to the approved timeline revision.

A playable editor is not a downloadable final file; a successful ffprobe header is not a full decode; a silent thumbnail is not mix verification. Deliver with explicit evidence and any limitation.

Before final-cut acceptance, follow [temporal-continuity-qa.md](temporal-continuity-qa.md). Record rendered continuity separately from timeline slivers, decode integrity and normal-speed playback.
