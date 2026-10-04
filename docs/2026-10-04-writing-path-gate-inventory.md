# Writing path gate inventory: topic → accepted draft (2026-10-04)

Inventory of every gate, required field, state and step on the current idea→draft path. Each one gets a proposed fate under the 4-step simplification:

1. **Main line.** The founder fixes a one-sentence main line, either by picking from 2–3 options or by saying it. The card shrinks to 3 fields: `mainLine` / `forWho` / `takeaway`.
2. **Research.** The host writer does the research. AutoCrew verifies quoted text against fetched pages (`validateQuote`).
3. **Write.** The writer works from a pack under 10k chars. Only two hard gates run at submit: unverified numbers and format markers.
4. **Codex review.** Codex reviews 3 things only: the main line can be said in one sentence, there is a usable takeaway, and the first 5 seconds hook. At most 2 bounce rounds.

The claim lock stays, but only to stop two sessions editing the same draft.

Branch `claude/autocrew-ideation-to-draft-246252` @ `6868e2ca`, which includes today's 选题会 merge `ba5d2102`. Paths are relative to the repo root. Line numbers are against this HEAD. "Origin" is the first code commit from `git log -S'<id>' --reverse -- src`.

**Measured fact:** recent real `writing-pack.md` files are **43–55k chars** (5 most recent, 09-27 to 10-03, under `~/AutoCrew资料库/.../01-script/research/`). The <10k target is a 5× cut, not a trim. The 12k "budget" in `input-budget.ts` covers only the research slot. Rules, structure menu, series, techniques, experiment and feedback blocks sit on top of it.

Fate legend:
- **KEEP**: stays as is, or trimmed only.
- **MERGE → X**: folded into a surviving mechanism X.
- **DROP**: removed. The "Still covered by" column names what, if anything, still prevents the original incident.

---

## Step 0/1 — Topic, prepare, readiness, angle selection

| # | Item | What it does · where | Origin · why (memory) | Fate | Still covered by (if DROP/MERGE) | Blast radius |
|---|---|---|---|---|---|---|
| 1 | topic create title+description | Required on `autocrew_topic create` · `src/tools/topic-create.ts:63` | Predates tracked history | KEEP | — | topic-create.test |
| 2 | `topic_has_drafts` | Delete refused while drafts exist · `topic-create.ts:85-91` | 0b43d465 (09-29) topic delete behind approval | KEEP (off-path) | — | legacy-local-backend.test |
| 3 | inspiration auto-create | `prepare` with no topic_id but an inspiration creates a topic · `src/tools/workflow.ts:246-253` | 84ea7d48 (10-04) 选题会 | KEEP | — | angle-gate.test, topic-meeting skill |
| 4 | `skip_removed` | skip_reason, `research_mode=skip` and research_reason are refused on a first draft · `workflow.ts:256-260`, `src/tools/writing-readiness.ts:124`, `src/modules/research/angle-gate.ts:31,174` | 84ea7d48: bypasses to the founder-angle rule | MERGE → angle gate (#50) | AI first body still needs a founder main line | 5 tests (angle-gate, writing-readiness, topic-angle, generate-script-angle/evidence) |
| 5 | research_mode validation (`auto`/`provided`; provided needs non-empty research) | `writing-readiness.ts:127-128,158-160` | 42a08c7e (09-25) host-driven flow: relays died 09-22 | MERGE → step 2 (provided material is research input, not a mode) | — | writing-readiness.test, workflow.test, write-script skill |
| 6 | `awaiting_host_research` + `research_task` | Host mode returns a scout task · `workflow.ts:265-273` | 42a08c7e | KEEP (step-2 entry, simplified task) | — | workflow.test, writing-flow.test, topic-meeting skill |
| 7 | providedNeedsCards | `provided` with no cards still dispatches scout to make cards · `workflow.ts:263-264` | 84ea7d48 | DROP | Options come from step 1, not from research | none direct |
| 8 | Readiness state machine | 5 overall × 8 research × 5 angle states · `writing-readiness.ts:20-53, 92-242` | 42a08c7e | MERGE → 3 states: `needs_main_line` / `researching` / `ready_to_write` | — | writing-readiness.test, workflow.test, generate.ts, writer-pack-view, chat-router |
| 9 | Job running / failed (engine deep research) | `writing-readiness.ts:170-181`; `workflow.ts:276` | 42a08c7e; engine job from 5942e6d8 (07-26) | MERGE → engine-only path, off the main writing flow | Visible failure kept for the engine path | research-handlers, ResearchPanel.tsx |
| 10 | **Brief stale / requirements freeze** (`creativeTaskMatches`, `topicHashOf`) | Any change to platform/requirements/direction text marks the brief stale and forces re-research · `writing-readiness.ts:140-143,182-186`; `src/modules/writing/creative-task.ts:32-42`; `research-job-store.ts:98` | 42a08c7e / 5942e6d8. Memory `autocrew-requirements-freeze-after-research`: adding "8–10 分钟" after select_angle gave `writing_not_prepared` and cleared the cards | DROP the requirements hash; KEEP topic text + main-line hash | Research is pinned to the main line. Duration and voice become pack-time amendments that don't invalidate research | creative-task.test, writing-readiness.test, workflow.test, scout task guard |
| 11 | No effective brief / no angle cards → `needs_attention` | `writing-readiness.ts:187-200` | 42a08c7e | DROP | Options precede research | writing-readiness.test |
| 12 | `host_angles_handoff` | `research kind=angles` unsupported in host mode · `workflow.ts:195` | 42a08c7e | DROP | — | dsh smoke-register.mjs:108-130 calls `research kind=angles` |
| 13 | `NO_BRIEF` | engine angles / select_angle need a brief · `workflow.ts:114,204,361` | bdb0f052 (07-26) | MERGE → main-line options no longer need a brief | — | research-handlers.test, topic-angle.test |
| 14 | `SEARCH_NOT_CONFIGURED` | Engine full research needs a search key · `workflow.ts:200-202` | 42a08c7e | KEEP (engine only) | — | workflow.test |
| 15 | angleOptionsView + recommendation | Card view; ranks by evidence coverage; `whyMayPerform` defaults to "无数据依据" · `src/tools/workflow-views.ts:43-149` | 42a08c7e view; 84ea7d48 whyMayPerform | MERGE → 2–3 main-line options view | — | workflow-views.test, chat-followup.ts, frontend AngleCards |
| 16 | `host_writer_preferred` | A host calling `workflow write` without `execution=engine` is refused · `workflow.ts:412-417` | 42a08c7e | KEEP | — | workflow.test, mcp/host-policy.ts:35 |
| 17 | `founder_words_required` | `select_angle` always needs the founder's own words · `workflow.ts:348-349` | 84ea7d48: a model picking the angle itself; memory `koubo-product-is-protagonist-not-lesson` (give 2–3 options, the founder picks) | **KEEP (core of step 1)** | — | angle-gate.test, topic-angle.test, skills topic-meeting / write-script / spawn-writer |
| 18 | Self-authored direction (`recordFounderAngle`) | Stores direction + founder words + topicHash · `angle-gate.ts:136-142`; `workflow.ts:352-357` | 84ea7d48 | KEEP ("or say it") | — | angle-gate.test |
| 19 | `brief_revision_required` / "角度候选已更新" / topic changed | `select_angle` must quote the current brief revision · `workflow.ts:362-375` | b73ae91f (09-25): a missing brief_revision was a silent failure; K b8cf37e5; I 42a08c7e | MERGE → option identity = topic hash + option id (no brief) | Still blocks selecting a stale option | workflow.test, writing-flow.test, frontend angle-choice.ts:36 |
| 20 | parseAngleCard immutability | On rewrite, id, cardVersion, coreEvidenceIds and anchor hash are locked; the quote must stay verbatim · `src/modules/research/angle-cards.ts:105-245` | b8cf37e5 / 71266599 | MERGE → 3 freely editable fields; founder edits are the point | — | angle-cards.test, angle-meeting.test, frontend angle-choice.ts:101-123, ipc.ts:1621-1665 |
| 21 | selectedAngle record `{briefRevision, angleId, card, chosenBy, founderWords}` | `workflow.ts:380-387`; `src/storage/local-store.ts:35-52` | 84ea7d48 chosenBy; b73ae91f | KEEP (shrink card to 3 fields, drop briefRevision) | — | local-store, desk.ts:84-87 writer inbox, status.ts:103,130, topic-expiry.ts:30, meeting-save.ts:33, dispatch-context.ts:61, frontend lib.ts:72-163 |

### Scout (host research) — becomes step 2

| # | Item | What · where | Origin · why | Fate | Still covered by | Blast radius |
|---|---|---|---|---|---|---|
| 22 | Scout schema `invalid_arguments` | `additionalProperties:false` · `src/tools/scout.ts:361-362` | 42a08c7e | KEEP (boundary validation per AGENTS.md) | — | scout.test, tool-contract.json |
| 23 | `topic_missing` / `engine_research_in_flight` | `scout.ts:374-375,281-288` | 42a08c7e | KEEP topic_missing; MERGE in-flight into the claim lock | — | scout.test |
| 24 | `task_changed` (+ `confirm_task_change`) | New requirements don't silently replace the task · `src/tools/scout-task-guard.ts:43-63`; `scout.ts:389,477` | b73ae91f: a silent task replace | MERGE → main-line pin (changing the main line = new research task) | Requirement edits no longer restart research (see #10) | scout-task.test, scout.test |
| 25 | `task_owned` / `lease_lost` (scout lease, 30 min) | `scout-task-guard.ts:11,19-36` | b73ae91f | MERGE → the single claim lock (#66) | One lock instead of two | scout-task.test, scout.test |
| 26 | `stale_task` / `task_required` | task_id fencing · `scout.ts:370-371,464-465` | 42a08c7e | KEEP | — | scout.test |
| 27 | `task_stale` (topicHash) | `scout.ts:276-280` | 42a08c7e | MERGE → main-line pin | — | scout.test |
| 28 | **4 parallel perspectives + perspective tokens** (claim / `perspective_claimed` / `perspective_done` / `perspective_token_invalid`, 30-min timeout) | `src/tools/scout-parallel.ts:24-98` | 84ea7d48 (10-04): parallel multi-perspective 选题会 | DROP | Host researches freely. Quotes are still page-verified (#33). The founder's one-sentence choice replaces angle diversity | scout.test, topic-meeting skill:13-31, tool-contract.json, writing-flow.test |
| 29 | `fail_perspective` (reason required) | `scout-parallel.ts:106-110`; `scout.ts:497-501` | 84ea7d48 | DROP | — | scout.test |
| 30 | `invalid_perspective` + perspective payload (≥2 insights, registered source_ids, verbatim quotes) | `scout.ts:144-148,616-620`; `src/modules/research/research-perspectives.ts:64-71,260-400` | 66097bd0 (07-26): quotes validated by code | DROP the payload schema; KEEP quote checking via #33 | `validateQuote` on every cite | research-perspectives.test, misuse-guide.ts:16, research skill |
| 31 | `stage_locked` / `task_complete` / replay | `scout.ts:483,503,604-615` | 42a08c7e | MERGE → idempotent cite (same quote = replay) | — | scout.test |
| 32 | Account-data 5th route + `account_data_failed`, `why_may_perform` (required per card) | `scout-parallel.ts:123-159`; `scout.ts:270-271,502-508,713-714` | 84ea7d48 / memory `topic-meeting` (bets against account data; metrics pull still off, so it mostly writes "无数据依据") | DROP as gate; account data stays optional input to step-1 options | — | scout.test, angle-gate.test, writing-flow.test, topic-meeting skill |
| 33 | **`validateQuote` + `cite` (`quote_not_verified`)** | Source must be a registered read page, quote must be a substring · `src/modules/research/research-broker.ts:399`; `scout.ts:548` | 5942e6d8 (07-26): "models cannot cite what was never read"; memory `number-gate-is-not-verification` (the real check lives here, not in the number gate) | **KEEP (core of step 2)** | — | research-broker.test, scout.test, writing-flow.test |
| 34 | `claim_offline` (claim + reason, ≤30 per task, `claim_quota`) | `scout.ts:544-598` | 42a08c7e; memory `evidence-gate-blocks-firsthand-material` (first-hand material had no way into the ledger) and `handoff-prereqs-new-library` (register recorded numbers as user_claim) | KEEP (the explicit own/user-claim lane) | — | scout.test, write-script skill |
| 35 | `task_busy` (lock, ≤4 concurrent read_page) | `src/modules/research/host-research-store.ts:138-166`; `scout-read-page.ts:50` | 42a08c7e | KEEP (infra) | — | scout.test |
| 36 | `perspectives_incomplete` | synthesize needs 4 perspectives + account data · `scout-parallel.ts:58-62`; `scout.ts:645-651` | 42a08c7e / 84ea7d48 | DROP | — | scout.test |
| 37 | Synthesis validation (`invalid_synthesis`, `source_mismatch`, `unknown_claim`) | `src/modules/research/research-synthesis.ts:256-290`; `scout.ts:656-680` | 66097bd0 | MERGE → research record = list of verified cites + own claims (no synthesis doc) | Quotes are verified at cite time | research-synthesis.test, scout.test |
| 38 | Brief publish: immutable revision, `brief_revision_conflict`, `missing_synthesis` | `scout.ts:289-322` | 42a08c7e; b73ae91f | MERGE → one research record per (topic, main line) | — | brief-store, brief-snapshot, ResearchPanel.tsx, chat-followup.ts |
| 39 | `seedLedgerFromBrief` marks brief evidence `verified_quote` unconditionally | `src/modules/research/evidence-ledger.ts:183-188` | 745a9a8d (09-04). Memory `number-gate-is-not-verification` calls this a real bug | DROP (ledger fed only by #33/#34) | Fixes the laundering bug | evidence-ledger.test, writer-prepare |
| 40 | Own material (transcripts / approved drafts as first-hand source; `HUMAN_VETTED`) | `src/modules/research/own-material.ts:97,239,348`; collected at `scout.ts:408-412` | 745a9a8d | KEEP (source for own_claim / first-hand) | — | own-material.test |

### Angle card fields and validation — becomes the 3-field main-line card

| # | Item | What · where | Origin · why | Fate | Still covered by | Blast radius |
|---|---|---|---|---|---|---|
| 41 | Card count 3–4 (`invalid_angles`) | `src/modules/research/angle-stage.ts:80-81,407` | 71266599 (09-04) v3 cards | MERGE → 2–3 options | — | angle-stage.test |
| 42 | Text fields: angle, thesis, misconception, mechanism, payoff, nextAction, counterResponse, hookDraft, antiScope (length caps) | `angle-stage.ts:216-219,282-293`; schema `:535-598` | b8cf37e5 (08-24) / 71266599. Memory `writing-depth-three-knives` (5/7 drafts rewrote the opening; the angle is first-hand) | MERGE → `mainLine` (thesis), `forWho`, `takeaway` (payoff); drop the rest | Codex review #1/#2/#3 check the written draft instead of card prose | angle-stage.test, brief-store.ts:114-203, frontend AngleCards.tsx:112-162, chat/cards.tsx:332-369, chat-router.ts:546-597, chat-followup.ts:78-175 |
| 43 | primaryPersona ∈ grow/trust/convert, personaGains, structure, elements | `angle-stage.ts:294-301`; `src/modules/research/personas.ts:9-43`; `brief-store.ts:134-139` | 71266599. Memory `koubo-no-template-distinct-thesis` (structure should grow from the thesis) | DROP (`forWho` replaces persona) | `forWho` + Codex #2 | personas.test, AngleCards.tsx, chat/cards.tsx |
| 44 | evidenceLevel / coreEvidenceIds / evidenceNeeds (grounded needs ≥1 non-user_claim; overview needs ≥2 needs) + `unverified_grounding` | `angle-stage.ts:85-86,304-329`; `scout.ts:715-724` | 71266599; 42a08c7e | DROP (research happens after the main line now) | Number gate at submit (#82) | angle-stage.test, frontend cards |
| 45 | **firsthandAnchor (verbatim quote of transcript / approved_draft / brief_evidence, excerptHash)** | `angle-stage.ts:160-163,221-280`; pack rule `src/modules/writing/script-prompt.ts:~407` | 71266599 + 745a9a8d. Memory `writing-pack-anchor-voice-fix` (a research quote was presented as the founder's words) and `autocrew-requirements-freeze-after-research` ("亲历不是一句话能改的") | DROP as a card field — **RISKY** | Must keep: (a) the pack rule "first-hand material comes only from the founder's own material / founder_words"; (b) `claim_offline` own_claim; (c) no ledger laundering (#39). Without (a), fabricated 亲历 returns | angle-stage.test, angle-cards.test, AngleCards.tsx (firsthandAnchor.quote), script-prompt |
| 46 | Empty-payoff check ("看懂/了解 X" with no action) | `src/modules/research/angle-meeting.ts:29-44`; `angle-stage.ts:375` | 9943569e (10-02). Memory `topic-meeting` ("payoff 太空") and `koubo-payoff-needs-solution` | MERGE → deterministic check on `takeaway` + Codex #2 | — | angle-meeting.test |
| 47 | Meeting fields forPersona {core/adjacent/surprise} + hookType + `meetingDeviation` | `angle-meeting.ts:46-82`; `angle-stage.ts:382-387` | 9943569e | MERGE forPersona → `forWho`; DROP hookType (Codex #3 checks the real hook) | — | angle-meeting.test, meeting-save.ts:33-49 (`angle_decision`), schedule-meeting skill |
| 48 | Distinctness: bigram Jaccard >0.6 → "same angle reworded" | `angle-cards.ts:42,321-341`; `angle-stage.ts:414` | b8cf37e5 (cards were near-duplicates) | MERGE → soft warning across the 2–3 options + series main lines (#71) | — | angle-cards.test |
| 49 | Code score (+1 grounded, +2 anchor); sorts only | `angle-stage.ts:186-214,416-420` | 71266599 ("scores sort, never select") | DROP | — | angle-stage.test |
| 49b | Legacy v2 engine cards (2–4, 6 fields) | `angle-cards.ts:34-35,269-372` | b8cf37e5 | DROP (keep a read-compat shim only for existing `selectedAngle`) | — | angle-cards.test, frontend lib.ts AngleCard v2 |

### Founder-angle gate / first-body guard (today's merge)

| # | Item | What · where | Origin · why | Fate | Still covered by | Blast radius |
|---|---|---|---|---|---|---|
| 50 | **`newDraftAngleRefusal` → `needs_founder_angle`** | First draft refused unless there is a fresh founder decision; next_action = topic-meeting `workflow prepare` · `angle-gate.ts:22-32,54-121` | 84ea7d48 (10-04): the founder must pick the angle in their own words | **KEEP (core of step 1)** | — | 9 test files; first-body-guard.ts:154; chat-router.ts:798; skills write-script / topic-meeting; MCP_INSTRUCTIONS |
| 51 | Freshness: `briefRevision == brief.revision && brief.topicHash == current` | `angle-cards.ts:70-79`; strict `angle-gate.ts:81-85`; `brief-snapshot.ts:89-98` | b8cf37e5; strict read 6c4d70a2; 567a9c2b (a card the founder picked must still be current) | MERGE → topic text hash + main-line hash only | Still blocks writing against an edited topic | angle-gate.test |
| 52 | `angle_gate_read_failed` | Strict read failure surfaces explicitly · `angle-gate.ts:91-97` | 84ea7d48 / 567a9c2b (a corrupt topic must be read_failed) | KEEP (AGENTS.md: visible failure) | — | angle-gate.test, topic-meeting skill |
| 53 | Readiness angle branch (bareDirection / recorded direction / `needs_angle` next_actions) | `writing-readiness.ts:203-241` | 84ea7d48 | MERGE → `needs_main_line` (#8) | — | writing-readiness.test, angle-gate.test, spawn-batch-writer skill (text asserted) |
| 54 | `newDraftGate` / `firstDraftRequestRefusal` at writer pack, workflow write, generate, OpenClaw | `writing-readiness.ts:248-272`; callers `writer.ts:279`, `workflow.ts:440`, `generate.ts:188,204` | 84ea7d48; 8d538de8 (OpenClaw accepted any direction / skip) | KEEP | — | generate.test, writer.test, openclaw bridge |
| 55 | **Storage choke point `guardFirstBody`** (provenance required; human/import pass; a model write needs a verified derivedFrom or a fresh founder decision + matching request via `decisionRequestRefusal`) | `src/storage/first-body-guard.ts:120-165`; `local-store.ts:769,1124`; `angle-gate.ts:148-192` | e6c9d72e (five review rounds of per-entry patches kept leaking); 6c4d70a2 (unmarked bearer treated as human); 365b0b17 (old packs committed after the angle changed); 0f7440bb | KEEP; simplify `decisionRequestRefusal` matching (card id + hash + briefRevision → main-line hash) — **RISKY to touch** | Ten Codex rounds closed bypasses here; a rewrite reopens C/D/F/G/H-class holes unless first-body-guard.callers.test stays green | angle-gate.test, first-body-guard.callers.test, every content write |
| 56 | Placeholder pinning (`isRealDraft` ignores status, exact `generatedPlaceholder`, `legacyPlaceholderOf`) | `first-body-guard.ts:66-112`; `local-store.ts:1993-1996` | 79687168 (status was gameable); 365b0b17 (fake placeholder prefix); 0f7440bb (editing the topic description turned a placeholder into a "real draft") | KEEP | — | angle-gate.test |
| 57 | `writer_submission_required` | content-save update / create_variant / model save can't fill a placeholder · `src/tools/content-save.ts:294-301,471-484,518-523` | 42a08c7e; create_variant gate 84ea7d48 | KEEP | — | content-save.test, rewrite-host.test, writing-flow.test |

---

## Step 3 — Writer pack, claims, submit gates

| # | Item | What · where | Origin · why | Fate | Still covered by | Blast radius |
|---|---|---|---|---|---|---|
| 58 | `historyGuard` (`imported_history`) | Imported history records never enter production · `src/tools/history-guard.ts:10`; `writer.ts:264`; `host-review.ts:281` | 32b0144c (10-03) / d3bd76ab | KEEP | — | 8 tests |
| 59 | Platform must be in `CLIPBOARD_PLATFORMS`; topic_id required | `writer-prepare.ts:207,211`; `writer.ts:276,290` | fa0e338c (09-06) | KEEP | — | writer.test |
| 60 | content_id re-pack: topic/platform match, status drafting/revision/draft_ready, submitted needs force, `needs_platform` | `writer-prepare.ts:217-222`; `src/tools/writer-revision.ts:42-53` | 0423dab1 / b73ae91f | KEEP | — | writer.test |
| 61 | **`pack_request_changed`** (requestKey + planningFingerprint: angle, profile, feedback; brief hash; gap) | `writer-prepare.ts:168,190,226-232,255-279` | 0423dab1 (09-22, preserve creator plans across MCP drafts; no body; docs/2026-09-22-writing-plan-fix.md). Memory `autocrew-requirements-freeze-after-research` | MERGE → one fingerprint = main line + platform; requirements/duration go in as `writing_amendments` without force | Re-pack still fences against a changed main line | writer.test, writer-series.test; text in write-script skill:24, adapters/codex AGENTS.editor-writer.md:22, dsh README:112, cordis.yml:50 |
| 62 | Pack reuse / unsubmitted placeholder reuse | `writer-prepare.ts:130,292` | fa0e338c | KEEP | — | writer.test |
| 63 | `pack_id` fencing / `stale_pack` ("写作包已作废") | `src/tools/writer-pack.ts:310`; `writer.ts:208-210,424`; `writer-submit.ts:146-148`; code at `writer-prepare.ts:120` | fa0e338c; f332264b (a late pack overwrote the pack id) | KEEP | — | writer.test, scout.test |
| 64 | Async pack machinery: states preparing/ready/failed, 15 s sync deadline, `pack_stalled` (>3 polls), orphan restart, `daemon_restarted` sweep, prep-consistency fail | `writer-pack.ts:124,255,275,296`; `writer-prepare.ts:89,91,413,465-477,509-532`; `writer-pack-view.ts:91,119` | f332264b (09-06: a sync pack outlived the 60 s MCP timeout); b73ae91f. Memory `pack-works-without-model-line` (pack assembly took 238 s) | MERGE → synchronous pack once it is <10k pure assembly; keep `preparing` only if measured >15 s | Fencing (#63) still prevents overwrite | writer.test, my-content-sync-back.ts:15,33, skills (`pack_status` ≤3 polls), MCP_INSTRUCTIONS |
| 65 | Per-content serialize queue | `writer-pack.ts:232` | fa0e338c | KEEP | — | host-review.ts, editorial.ts import it |
| 66 | **Claim write gate (`claim_held`, token required even same-host)** | `src/storage/claims.ts:407,360,131`; `writer.ts:171,336,358,368` | bf14f3f6 (09-06, two hosts share a data dir); 800a87c1 (09-25, two Claude sessions overwrote each other's draft) | **KEEP (the one lock)** | — | 17 tests; pre-publish, cover-review, video-handoff/gates, tool-runner.ts:89 |
| 67 | Pack auto-claim with warning + holder | `writer.ts:315-323` | 800a87c1 | KEEP | — | — |
| 68 | Lease 30 min (editing heartbeat 48 h) | `claims.ts:36,49` | bf14f3f6. Memory `handoff-prereqs-new-library` (a failed handoff stole the claim; wait 30 min) | KEEP | — | claims tests |
| 69 | Takeover only after ≥10 min idle (harness-decided) | `claims.ts:43,236-257` | 7a8ddda7 ("a flag the model fills in is not a gate") | KEEP | — | 5 tests |
| 70 | local-user override + `withTokenInNextAction` | `claims.ts:134,370`; `src/tools/claim-grant.ts:5` | 800a87c1 | KEEP | — | claim_token in 32 tests |
| 71 | **Series snapshot frozen into the pack** (same platform, 30 days, ≤10 items × 1500 chars) | `src/modules/writing/series-memory.ts:64-67,153`; frozen at `writer-prepare.ts:311` | 19d9ebc3 → c08e4298 (09-28). Memory `koubo-no-template-distinct-thesis` (same skeleton and same thesis across a series) and `koubo-no-padding-no-boilerplate` | MERGE → step 1 shows the last ≤10 **main lines** (one line each) and the founder picks a distinct one; drop full outlines from the pack — **RISKY** | Codex #1 + the founder seeing prior main lines. Repeated boilerplate sentences across drafts are no longer caught mechanically | series-memory.test, series-review.test (24 refs), writer-series.test, local-store outline/seriesSnapshotId fields, series-transaction.ts:14 |
| 72 | Technique catalog frozen into the pack (approved only; `invalid_approved_technique`, `founder_card_in_bundle`, `duplicate_technique_version`) | `src/modules/writing/technique-store.ts:71-95`; `writer-prepare.ts:312` | 19d9ebc3 / c08e4298. Memory `writing-rules-cleanup-0928` (rules demoted to opt-in "手法卡") | DROP from pack (store may stay as a library) | Techniques were always optional ("可以一张都不用") | technique-store.test, writer-series.test, host-review.ts:135, local-store technique_ids |
| 73 | Editorial experiment block (≤1800 chars; one active per platform; >1 match throws) | `src/modules/retro/editorial-experiments.ts:17-25,92-122`; `generate-script.ts:686-702`; `writer-prepare.ts:391-395` | 5dfe3489 (retro findings never reached a draft); file moved in 620230d0. Memory `retro-into-writing-loop` | MERGE → one ≤300-char line in the pack. If dropped outright, `retro.ts:204-222` keeps writing experiments nothing reads | — | editorial-experiments.test, retro.test, library-manager.ts:23 |
| 74 | Writing feedback appended to the pack | `src/modules/writing/writing-feedback.ts:26`; `writer-prepare.ts:397-402` | 0423dab1. Memory `feedback-loop-implicit` (learning is automatic) | KEEP (capped) | — | 8 tests |
| 75 | Research-slot budget 12k (core evidence 4k, brief 2.8k, anchor 2k, user research 2k, voice 1.5k) | `src/modules/writing/input-budget.ts:26-33` | 1e267e24 (09-04). Fix for the budget falling back to 20k: 4fa0b6f | MERGE → whole-pack budget <10k (real packs measured at 43–55k) | — | input-budget.test (budget table "测试锁定") |
| 76 | Ledger index in pack_md (40 entries × 80 chars) + `ledger_ids` | `writer-pack.ts:327-346`; `writer-pack-view.ts:75` | 19618099 (09-25: provided mode had no evidence ids) | KEEP (shrink) | — | writer.test |
| 77 | `find_evidence` engine quota = 3, 45 s wall clock | `src/modules/research/evidence-ledger.ts:79`; `writer.ts:227-243`; `targeted-research.ts:54` | 745a9a8d / f332264b. Memory `evidence-gate-blocks-firsthand-material` (3 lookups wasted on YouTube pages) | DROP (engine lookup) | Host does research via `cite` (#33) | writer.test, targeted-research.test, write-script skill, adapters, misuse-guide, tool-docs |
| 78 | `find_evidence` host mode → `awaiting_host_evidence` + scout task + `citation_target` | `writer.ts:186,214-225` | 42a08c7e | MERGE → step-2 cite against content_id (`scout-content-evidence.ts`) | — | writer.test |
| 79 | Host evidence cap 12 per draft (`evidence_quota`, not reset by force) | `src/tools/scout-content-evidence.ts:23,119-120`; `writer-pack.ts:427,441` | 19618099 | MERGE → cap only self-declared own/user claims; verified cites uncapped | Still stops unbounded self-declared numbers | scout-content-evidence.test |
| 80 | `creative-task` inherit semantics (omitted = inherit, "" = clear) | `creative-task.ts:15,25` | 42a08c7e | MERGE → amendments | — | creative-task.test |
| 81 | **Format gate** (`format_markers`: [画面]/[字幕]/镜头N/B-roll in the body) | `src/modules/writing/format-gate.ts:24,103`; enabled at `generate-script.ts:829` | 745a9a8d. Memory `koubo-script-no-shot-notes` | **KEEP (hard gate 1 of 2)** | — | format-gate.test + 2 |
| 82 | **Number gate** (`unverified_numbers`; value + unit family must match a ledger entry; ordinals exempt) | `src/modules/writing/number-gate.ts:341,380,431`; SOURCE_RANK `:408` | 745a9a8d ("5" matched "15"). Memories `number-gate-is-not-verification` (passes on any same value; own/user_claim count) and `evidence-gate-blocks-firsthand-material` | **KEEP (hard gate 2 of 2)** — feed it only from #33/#34 | — | number-gate.test + 3 |
| 83 | needs-human vague quantities (十几/数十) soft | `number-gate.ts:89,442` | 745a9a8d | MERGE → advisory note on #82 | — | 6 tests |
| 84 | Quality gate soft checks: min_chars / max_chars / `min_data_points` / `min_image_tags` / `banned_hook` | `src/modules/writing/quality-gate.ts:24-36,54,69,97,118` | 4f8c3599 (P0 stage 1, wechat pack). Memory `evidence-gate-blocks-firsthand-material` (min_data_points stricter than the number gate) | DROP | banned_hook → Codex #3; length → advisory; min_image_tags: **wechat articles lose the image-marker floor** (note) | quality-gate.test, platform gate configs |
| 85 | `gate_notes` (soft failures carried after rounds are spent) | `writer-submit.ts:450` | fa0e338c | DROP (with #84) | — | — |
| 86 | Repair budget (2 rounds; not saved) | `src/modules/writing/script-payload.ts:149,195,227`; `writer-submit.ts:400,407` | 745a9a8d | KEEP (for the two hard gates) | — | writer-submit.test |
| 87 | `blocked` → content `needs_evidence` | `writer-submit.ts:315-352,401` | 745a9a8d / 1e267e24 (hard-gate exhaustion must not reach draft_ready) | KEEP | — | needs_evidence in 11 tests; frontend Editor.tsx:576, board-columns.ts:356, BoardCards.tsx:88, StageAdvance.tsx, TopicMatrix.tsx:197, stage-default.ts:20; dashboard.ts:155-188 |
| 88 | Payload shape (title/body required; body ≤12000, title ≤80, hashtags ≤10, technique_ids ≤10) | `script-payload.ts:43,61-63,78-107` | fa0e338c | KEEP (boundary; drop the technique_ids line) | — | writer.test, guidance test JSON examples |
| 89 | **`outline_required`** | New-contract packs must submit an outline (中心思想/信息点/骨架/说过的东西) · `writer-submit.ts:380-382`; `series-memory.ts:21,39` | 19d9ebc3 → c08e4298 (outline drives series memory; stops padding) | DROP | Codex #1 checks the main line on the draft itself; gap exit (#92) still stops padding | writer-series.test, local-store outline / outlineDraftHash, series_review |
| 90 | **`unknown_technique`** | `writer-submit.ts:383-387` | 19d9ebc3 → c08e4298 | DROP (with #72) | — | writer-series.test |
| 91 | `attempt` integer / replay / `attempt_conflict` / stale retry / pending-review block / writable status | `writer-submit.ts:99,114,152,162-206` | b73ae91f (a reused attempt with a different body was silent) | KEEP | — | writer-submit.test, writer-series.test |
| 92 | Gap record (`gap` action → `needs_material`; gapped pack refused on submit/reuse) | `writer.ts:420-439`; `writer-submit.ts:371,519`; `series-memory.ts:54` | c08e4298; d629a028 (submitting on a gapped pack reached draft_ready) | KEEP (honest "material runs out" exit, not a quality gate) | — | writer-series.test, host-review.ts:223 |
| 93 | Length hint (advisory) | `series-memory.ts:253`; `writer-submit.ts:219` | c08e4298. Memory `writing-rules-cleanup-0928` | MERGE → pack text | — | writer-series.test |
| 94 | Direct revision `revision_of` (CAS on draft_hash → `stale_draft`) | `writer-revision.ts:109-124` | b73ae91f | KEEP | — | writer-submit.test, editorial.ts |
| 95 | Revision cycles 3 per pack → `revision_budget_exhausted` (`needs_human`) | `writer-revision.ts:92,130-147` | b73ae91f | KEEP (founder-driven revisions; separate from Codex bounces) | — | writer-submit.test, video-session skill |

---

## Step 4 — Review desk → accepted

| # | Item | What · where | Origin · why | Fate | Still covered by | Blast radius |
|---|---|---|---|---|---|---|
| 96 | `awaiting_host_review` (default `review=host`; review_pack inline) | `writer-submit.ts:463-490` | 42a08c7e; b73ae91f (inline review pack) | KEEP (Codex route) | — | 6 tests; skills; WRITING_INSTRUCTIONS asserted by writing-guidance.test:112 |
| 97 | `review=none` → `accepted_unreviewed` (`disclose_review_gap`) | `writer-submit.ts:360,454`; `src/tools/writer-review.ts:262-274` | fa0e338c / 42a08c7e | KEEP (honest disclosure) | — | 4 tests |
| 98 | `review=engine` → `reviewing`, engine script-review loop (P1c six blockers, 刀3) | `writer-submit.ts:494-507`; `src/modules/writing/script-review.ts` | 65f23327 (08-23, AI reviewer); P1c. Memory `writing-depth-three-knives` | DROP from the host path (keep only if a no-Codex fallback is wanted; otherwise `accepted_unreviewed`) | `accepted_unreviewed` discloses the gap | script-review*.test, chat-router.ts:1242-1266 (audience_review), generate-script |
| 99 | review_desk schema check + `historyGuard` + no-ready-pack | `src/tools/host-review.ts:49-58,279-290` | 42a08c7e | KEEP (new schema) | — | host-review.test, tool-contract.json |
| 100 | `stale_review` (pack id / attempt / draft hash / superseded) | `host-review.ts:221-225`; `writer-review.ts:355,366` | 42a08c7e | KEEP | — | 3 tests |
| 101 | `review_conflict` / replay | `host-review.ts:229-231` | 42a08c7e | KEEP | — | host-review.test |
| 102 | Mode check + "先 pack 领取审稿材料" (audienceContext frozen at pack) | `host-review.ts:233-234` | 42a08c7e | MERGE → review pack = main line + forWho + takeaway + draft | — | host-review.test |
| 103 | Issue validation (severity, rule, instruction, **verbatim quote 6–60 chars**; `invalid_review`) | `host-review.ts:236`; `script-review.ts:188-228` | 42a08c7e / 65f23327 (19/19 quotes hit on real drafts) | KEEP, re-scoped to the 3 checks (each blocker quotes the draft) | — | host-review.test, content-review skill JSON example |
| 104 | **Audience review** (audienceBasis current_task/profile, verdicts 1–3 core/adjacent/surprise, wouldStop, `losesAt` verbatim ≤3, suggestions) | `host-review.ts:44,189-213`; `src/modules/review/audience-review.ts:22` | 42a08c7e. Memories `autocrew-requirements-freeze-after-research` (a descriptive losesAt voided the whole review) and `audience-non-technical` | MERGE → Codex check #3 (first-5-seconds hook, quoted) + #2 judged for `forWho`; drop tiers | Audience drift is caught by `forWho` on the card + Codex #2 | host-review.test, frontend chat/cards.tsx:145-151, chat-router.ts:1242-1266, scripts/eval/world.ts:116-140 |
| 105 | **series_review** (snapshot id, full `checked` coverage, `insufficient`, findings quotes; `invalid_series_review`, `series_snapshot_stale`) | `host-review.ts:109-180,251-257`; `series-memory.ts:195,215-233` | 19d9ebc3 → c08e4298. Memory `koubo-no-template-distinct-thesis` | DROP — **RISKY** | Step-1 distinct main line vs prior main lines (#71) + Codex #1. Cross-draft repeated sentences are no longer checked | series-review.test (24 refs), series-memory.test, writing-flow.test, tool-contract.json |
| 106 | Claim gate on review submit | `host-review.ts:248` | 800a87c1 | KEEP | — | — |
| 107 | `MAX_REVIEW_ROUNDS=2` → `review_required` (→ revision) / `accepted_with_issues` | `writer-review.ts:66,289-335` | fa0e338c | **KEEP (= max 2 bounces)** | — | writer.test, handoff tests |
| 108 | `accepted` → `draft_ready`; quality_status host_self_reviewed / host_reviewed / passed / passed_with_notes | `writer-review.ts:276-287,399-403` | fa0e338c / 42a08c7e | KEEP (collapse quality_status values later) | — | draft_ready in ~100 tests |
| 109 | Reviewer identity: `host_self_review` label; `independent:false` hard-coded; no check that the reviewer is Codex | `host-review.ts:~128` (prompt rule) | 42a08c7e | MERGE → open question: should "Codex reviews" become a harness check (reviewer host ≠ writer host)? Today it is only a label | — | host-review.test |
| 110 | Engine-path stale → `accepted_unreviewed` + `quality_status:stale_review`; `submit_status` stale receipt | `writer-review.ts:226-227,473-484` | f332264b | KEEP submit_status; DROP the engine branch (#98) | — | writer.test |

### After acceptance (not on the 4-step path, listed for completeness)

| # | Item | What · where | Origin · why | Fate | Blast radius |
|---|---|---|---|---|---|
| 111 | Editorial `user_confirmed:true`, feedback capture (draft_hash, event_id, verbatim selection, `stale_draft`) | `src/tools/editorial.ts:84-151` | 42a08c7e | KEEP | 6 tests, `index.ts:259-281` autocrew_revise |
| 112 | Long-term rules pending-only; founder activates (`blocked_by_tombstone`) | `editorial.ts:120-131`; `writing-rules.ts:62-138` | 889dc5e2 | KEEP | rule-approval.test |
| 113 | Adoption derivation (bigram) | `src/modules/learnings/adoption-derive.ts:51,88` | — (memory `feedback-loop-implicit`) | KEEP | own test |
| 114 | Content status enum + `STATE_TRANSITIONS` | `local-store.ts:160-196,1692,1876` | 767abcc1 | KEEP | state-machine.test |
| 115 | Founder-only statuses (approved+) → `founder_decision_required` | `production-hooks.ts:36-43,85-112`; `local-store.ts:1817,1890` | c8548ac4. Memory `video-approval-forgery-fix` | KEEP | 2 tests |
| 116 | 等你认稿 bucket = draft_ready + 写稿中 | `src/tools/status.ts:112,141`; `derive.ts:317` | 47895d1f. Memory `board-drag-rules` | KEEP | 3 tests |
| 117 | Video handoff acceptance (`review.status` passed/revised + hash match → else `not_accepted`) | `src/modules/video/handoff/acceptance.ts:15-85` | 800a87c1 | KEEP — **must accept the new review verdict values**, or handoff blocks forever | handoff, acceptance, review-inbox-covers tests |
| 118 | Desktop engine pre-write research gate (`makeEnsureBrief`, waits ≤12 min, degrades with a visible trace) | `src/desktop/write-research-gate.ts:21,87` | bbb478c5 (08-23: 220 drafts, only 1 had a brief). Memory `writing-depth-three-knives` | MERGE → engine path only; host path does step 2 | write-research-gate tests, ipc.ts:534-600 |
| 119 | Legacy `autocrew_review` (mechanical checks only) | `src/tools/review.ts:13-16` | 42a08c7e | KEEP (unrelated) | review.test |

---

## Counts

120 rows (#1–#119 plus 49b), counted by the first word of each row's Fate cell:

| Fate | Count | Rows |
|---|---|---|
| **KEEP** | 62 | 1, 2, 3, 6, 14, 16, 17, 18, 21, 22, 23, 26, 33, 34, 35, 40, 50, 52, 54, 55, 56, 57, 58, 59, 60, 62, 63, 65, 66, 67, 68, 69, 70, 74, 76, 81, 82, 86, 87, 88, 91, 92, 94, 95, 96, 97, 99, 100, 101, 103, 106, 107, 108, 110, 111, 112, 113, 114, 115, 116, 117, 119 |
| **MERGE** | 35 | 4, 5, 8, 9, 13, 15, 19, 20, 24, 25, 27, 31, 37, 38, 41, 42, 46, 47, 48, 51, 53, 61, 64, 71, 73, 75, 78, 79, 80, 83, 93, 102, 104, 109, 118 |
| **DROP** | 23 | 7, 10, 11, 12, 28, 29, 30, 32, 36, 39, 43, 44, 45, 49, 49b, 72, 77, 84, 85, 89, 90, 98, 105 |

Four rows are split, and each is counted under its first word:
- #10: drops the requirements hash, keeps the topic + main-line hash.
- #23: keeps topic_missing, merges the in-flight check.
- #47: merges forPersona, drops hookType.
- #110: keeps submit_status, drops the engine branch.

About 28 of the 62 KEEPs are infrastructure: fencing, idempotency, claims, the status machine, after-acceptance items. They are not writing-quality gates.

The writing-quality gates that survive are:
- Step 1: `founder_words_required`, the angle gate and the choke point (#17, #50, #55).
- Step 2: `validateQuote` and `claim_offline` (#33, #34).
- Step 3: the format and number gates with 2 repair rounds, then `blocked → needs_evidence` (#81, #82, #86, #87).
- Exits: gap (#92).
- Step 4: 2 review rounds (#107).

## Riskiest drops / merges

1. **#45 firsthandAnchor.** It is the only structural guard that keeps a research quote from being presented as the founder's 亲历 (memory `writing-pack-anchor-voice-fix`). Dropping the field is safe only if the pack keeps the hard rule "first-hand material = founder's own material / founder_words only" and #39 stops ledger laundering.
2. **#55 storage choke point.** We keep it, but simplifying `decisionRequestRefusal` touches code that took 10 Codex review rounds today. Keep `first-body-guard.callers.test.ts` and `angle-gate.test.ts` as the acceptance bar.
3. **#71 + #105 series snapshot / series_review.** These are the only mechanical defense against "same skeleton / same thesis / repeated boilerplate across a series" (memories `koubo-no-template-distinct-thesis`, `koubo-no-padding-no-boilerplate`). The replacement (prior main lines at step 1 + Codex #1) does not catch repeated sentences.
4. **#10 requirements freeze.** Dropping it is the point, because it caused the 09-26 re-research. But research then has to be pinned to the main line, or edits to the main line would silently reuse research gathered for a different claim (b73ae91f `task_changed`).
5. **#84 quality gate.** Wechat articles lose the `min_image_tags` floor and the `banned_hook` list. Codex #3 covers hooks but not image markers.
6. **#117 handoff acceptance.** It reads `content.review.status` passed/revised. A new review schema must still write those values, or video handoff dead-ends.

---

## External callers that break if an action or field disappears

| Surface | File:line | Uses | Breaks if removed |
|---|---|---|---|
| MCP initialize text | `mcp/writing-instructions.ts:3-12,27-35` | prepare, scout lanes, perspective claim, select_angle + brief_revision + founder_words, pack / pack_status / find_evidence, claim_token, submit, awaiting_host_review, review_desk submit {audience, series_review} | Hosts follow a stale flow; `mcp/writing-guidance.test.ts:112-114` asserts "awaiting_host_review" |
| MCP tool docs / hints / misuse | `mcp/tool-docs.ts:19-22,63-85`; `mcp/misuse-guide.ts:13-19` | per-action docs; PARAM_HINTS (brief_revision, perspective_token, founder_words, review_pack_id…); next_action rewrites | Wrong descriptions; misuse-guide.test:28-34 fails |
| Schema snapshot | `mcp/__fixtures__/tool-contract.json`; `mcp/tool-surface.test.ts:57-62` | exact schemas for workflow / scout / writer / review_desk / desk | Any schema change → regenerate the fixture |
| MCP resources | `mcp/server.ts:98,~105,122,133-136` | writing-guide, `contents/<id>/writing-pack` (reads writing-pack.md), desk/writer, prompts write_content / revise_content / review_content | Prompts go stale; the resource returns -32002 if the pack file isn't written |
| Host policy | `mcp/host-policy.ts:35,67`; `src/desktop/host-connect/detect.ts:113` | `workflow write`, `writer submit` define canWrite | Host connect thinks the host can't write |
| Journey tests | `mcp/writing-flow.test.ts` (309-353 needs_founder_angle, 397 feedback→pack force); `mcp/writing-guidance.test.ts:37-110` | full chain; skill JSON examples validated against scout / writer / reviewDesk schemas; README / adapters / templates must mention scout, review_desk, host_self_review | Must be rewritten together with the skills |
| Tool registration | `index.ts:28-31,81-96` (+ text at 64,74,162,192,242); `index.ts:259-281` autocrew_revise | registers workflow / scout / review_desk / writer / desk; revise → editorial → writer pack force | OpenClaw and dsh registration |
| Other tools | `src/tools/generate.ts:8,41,103,167,188,204`; `rewrite.ts:9,192`; `content-save.ts:37,138,204,297-301,478,523`; `content-summary.ts:26-56` (usedAngle, activeAngleCard, pack.submittedAt); `editorial.ts:11-13,98,108,128`; `desk.ts:84-87,130-138` (writer inbox = topics with selectedAngle); `status.ts:103,130` | readiness gates, next_action strings, selectedAngle, pack fields | Writer inbox and to_write counts go empty if `selectedAngle` disappears |
| Video | `src/tools/video-handoff.ts:72-96` (writer claim); `src/modules/video/handoff/acceptance.ts:61-85` (review passed/revised + draft_hash); `handoff/project-evidence.ts:38` (evidenceLedger citation coverage); `match.ts:80` | review status, ledger | Handoff blocks forever if review verdicts or the ledger change shape |
| Update / long-running | `src/modules/update/long-running.ts:79,102-107` | `topic:select_angle`; scout search/read_page, workflow prepare/research/write/draft, writer pack/find_evidence/submit, review_desk submit | The busy check misses new long actions |
| Storage types | `src/storage/local-store.ts:35-52,77-79,143-148,327-341,400-458,1018-1024,1144-1167`; `first-body-guard.ts:154`; `claims.ts:108,217,262`; `my-content-sync-back.ts:15,33`; `content-project.ts:80` | selectedAngle / founderAngle, outline, technique_ids, seriesSnapshotId, seriesReview, gapRecord, genRequest, usedAngle, evidenceLedger, pack, claim | Type and merge breakage; needs a migration for existing selectedAngle cards |
| Desktop IPC | `src/desktop/ipc.ts:534-600,1364,1621-1670`; `channel-contracts.ts:127` (topic:select_angle requires topic_id, brief_revision, angle_id); `channels.ts:152`; `board-actions.ts:65`; `topic-expiry.ts:30-34`; `dispatch-context.ts:61-72`; `research-handlers.ts`, `write-research-gate.ts`, `orphan-reconcile.ts`, `digest-reply.ts` | brief_revision + card payload → parseAngleCard; engine generate | Workbench angle pick breaks on any card-schema / brief_revision change |
| Chief editor (built-in chat) | `src/desktop/chat-router.ts:546-597` (angle_cards push: id, angle, thesis, antiScope, audiencePain, hookDraft), `731-800` (generate_script: angle_id, direction, founder_words, needs_founder_angle), `1242-1266` (audience_review / losesAt), `1478,1513` (deep_research / regenerate_angles); `chat-followup.ts:78-175` | engine path, not MCP | Card rendering and the founder_words flow in chat |
| Meetings | `src/modules/meetings/meeting-save.ts:33-49` (`angle_decision` rerun / accept_deviation when a topic has selectedAngle or cards); `deep-research.ts:357` meetingAngleContext | selectedAngle, cards, meetingDeviation | Weekly slate save logic |
| Frontend | `frontend/src/lib.ts:36-41,72-163,200-222`; `views/AngleCards.tsx:86,112-162,269-298`; `views/angle-choice.ts:36,101-123`; `views/ResearchPanel.tsx:275-413`; `chat/cards.tsx:145-151,332-369,403`; `views/host-badge.ts`, `HostBadges.tsx`; needs_evidence in `Editor.tsx:576`, `board-columns.ts:356`, `BoardCards.tsx:88`, `StageAdvance.tsx:21,34`, `TopicMatrix.tsx:197`, `stage-default.ts:20` | every v2/v3 card field, briefRevision, select / clear angle, pack / claim badges, audience verdicts | Card UI shows empty fields; select payload rejected |
| Skills | `skills/write-script/SKILL.md:11-63`; `skills/topic-meeting/SKILL.md:13-31` (perspective tokens, fail_perspective, account_data, why_may_perform, angle_gate_read_failed); `skills/schedule-meeting/SKILL.md:41-44`; `skills/spawn-writer:11-21`; `skills/spawn-batch-writer:12-15` (exact strings test-asserted); `skills/research:15-38` (JSON validated); `skills/video-session/SKILL.md:16-91` + `references/codex-handoff.md:8-21`; `skills/platform-rewrite:15-16`; `skills/content-review:15-20` (JSON validated vs reviewDeskSchema); minor: manage-pipeline, topic-ideas, calibrate, pre-publish, onboarding, humanizer-zh, style-calibration, cover-generator | the whole chain | Runtime-loaded; writing-guidance.test fails |
| Adapters / templates | `adapters/codex/AGENTS.editor-writer.md:11-59` (installed by `host-cli.ts:103` into users' AGENTS.md / CLAUDE.md; scanned by persona-capabilities.test:41-51); `adapters/codex/README.md:70-92`, `AGENTS.editor.md`, `AGENTS.cover.md`; `adapters/dsh/src/tools.ts:45-60`, `scripts/smoke-register.mjs:108-130` (needs `research kind=angles`), `README.md`, `agent-presets/autocrew/agent.cordis.yml:41-56`; `templates/AGENTS.md:12-13`; `README.md:252-256`; `docs/2026-09-22-host-driven-mcp.md:14` (test-asserted) | copies of the write-script flow | Users' installed AGENTS.md go stale; dsh smoke fails |
| Evals | `scripts/eval/world.ts:116-140`, `seeds.ts:46-50`, `invariants.ts:103-122`, `scenarios.ts:45,130,167` | prepare(provided + direction) → pack → submit → review_desk(audience losesAt) | **Likely already broken by today's gate**: no select_angle + founder_words, no outline (unverified, not run) |
| Non-core tests | host-review, series-review, history-guard, desk, claim-grant, persona-capabilities, generate, writing-readiness, topic-angle (15 refs), ipc, server-api-auth, workbuddy-connect, legacy-local-backend, flywheel/work-claims, video/handoff, update-review-8, production/verifier-fixes | — | Update alongside |

## Notes / unverified

- Gate counts and line numbers come from read-only greps on this HEAD. No tests were run.
- `editorial-experiments` has no "pending" state in code. The `.pending.json` rename in memory `retro-into-writing-loop` was a one-off deployment step.
- No code requires the reviewer to be Codex (#109). "Codex reviews" in the 4-step design is either a prompt convention or a new harness check, which needs a decision.
