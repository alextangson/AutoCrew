# Four-gate production contract

## Initialize without a fifth creative gate

Resolve one project, approved identity assets and the actual production request. Reuse valid identity approvals; include changed outfits/identity in Gate 2 instead of reopening the character library. Do not assume pending assets are approved.

Establish an upload/spend envelope using existing concrete authorization. Missing paid-API prices, currencies, provider consent or cash caps cannot be inferred from “自动完成”. Bundle missing paid storyboard-image scope into Gate 1; bundle paid H3, music/SFX and any explicitly selected API-cover allowance into Gate 2. Default Codex subscription covers require no cash cap, API key or relay quote; track quota use separately. If an earlier necessary paid operation lacks authority, explain the single concrete blocker. Platform-required confirmation still applies.

Persist `workflow-state.json` and `production-profile.json` under project notes. Save actual review artifacts and exact user messages, not invented approval quotes.

## Gate 1 — editable rough cut

For this user, the editing and review surface is ChatCut Desktop, confirmed on 2026-10-07. Verify the editable ChatCut timeline before requesting rough-cut approval. A Jianying transfer is required only when the user explicitly requests it.

Before review:

1. Import the authorized original recording into the resolved working editor and place it on the timeline before rough-cutting. Use original-source clips with editable in/out ranges; never substitute a rendered rough-cut MP4. Verify the target ChatCut project and timeline before editing. Transcribe and cut by complete meaning, removing failed/repeated takes without losing qualifications, breathing or personality. This user's defaults (confirmed 2026-09-30):
   - Retakes: the user re-records a sentence until satisfied, so keep the last complete take unless an earlier one is clearly better; also strike in-sentence restarts ("直接直接", "不要替我…别替我补") and unfinished fragments.
   - Ad-libs: the spoken version is the source of truth. Keep lines not in the script; use the script only to locate retakes, and flag only factual risks.
   - Pauses: about 0.3 s between sentences (0.5 felt draggy — the gaps often contain teleprompter adjustments). Shorter natural breaths stay.
   - Fix ASR errors in the transcript before captions exist: AI is 「它」, a female example character (e.g. 小林) is 「她」, plus homophones such as 交得/空着/会话.
   - At review, list the retake choices, the pause value and the transcript fixes so the user can check the decisions, not only the result.
2. Smooth speech cuts after structural transcript edits, then refresh captions once.
3. Save the actual timeline snapshot, original-media-to-timeline timing map and matching SRT. Check playback at cuts and sentence boundaries.
4. Verify that speech clips reference the original recording and that cut handles can be extended to recover adjacent source speech in the editor. An external EDL alone is insufficient. Record rough-cut duration, FPS, timeline ID/revision and SRT hash. Include the paid static-board allowance if not already authorized.

Show the rough cut with only meaningful structural changes summarized, as `autocrew_content ask kind=粗剪` (options such as 可以 / 还要改, attachments inside the project) so it lands in 「等你拍板」. Approval freezes speech timing, not a guessed target duration. A later speech rewrite returns the changed rough cut to Gate 1 and makes downstream timing stale; wording corrections without timing change have scoped semantic impact.

## Gate 2 — one storyboard and execution package

Present collected real material and AI storyboard proposals using the shared [material review page](material-review-page.md). Show actual previews, speech timing, provenance or exact generation scope, and open gaps. This page is the existing Gate 2 presentation, not another approval. Report each version with `autocrew_content record kind=storyboard`, then `autocrew_content ask kind=分镜 fact_id=<storyboard fact_id>` with an `approve` option; show the page to the founder in chat; their verbatim chat answer (recorded with `answer_ask`) or a click in 「等你拍板」 decides. Put the paid generation scope in a separate `ask kind=花费` and state the amount in chat; their explicit chat answer to that ask authorizes the spend — a 行 to something else does not. After insertion, produce a new execution view with playable results and actual placement; preserve the approved snapshot.

Read the whole approved SRT and inspect A-roll. Use director-quality-bar.md for coverage. Reuse approved Xiaolu assets and build clean start/result images plus separate labeled cards.

Storyboard images are sequential only within a shot (the result image edits that shot's start image); shots are independent. When dispatching more than ~4 images, split them by shot across 2–3 parallel image jobs from the start, each owning distinct shot IDs and output filenames, so one slow or reconnecting job does not stall the whole package (2026-09-28: a single 12-image job lost ~10 minutes to one reconnect, then ran ~1.4 min/image). Do not add parallel jobs to a batch that is already running — it cannot be told to skip shots, and two writers can collide on the same file.

Show together:

- actual versioned cards and shot IDs; source claim, causal action, result, humor and transitions;
- planned full B-roll, explanation-dominant mixed and effective union duration/percentage;
- one representative caption/keyword treatment if not established, following subtitle-packaging.md; the user's 新青年体、无描边、柔和阴影 preference is already established and does not need renewed confirmation;
- exact fal endpoint, duration, resolution, relevant request parameters, clean input hashes and reference price source/date with approximate costs (for H3, use minimax-h3-video-creator/references/price-estimates.md; no routine live-price lookup);
- base estimate, maximum attempts per shot, objective retry triggers and allowed `clarify_motion` wording repair (or exact prompt only);
- whole-project paid ledger: already spent/committed, remaining paid image/music/SFX/API-cover allowances, generation worst-case and total cash cap; separate subscription usage, licensing constraints and permitted editorial fallbacks. Do not assign a mandatory cash allowance to subscription covers.

One clear response to this concrete package populates separate creative and generation approvals. A reply approving only visuals does not approve unshown cost. Do not require a second confirmation of unchanged scope.

After approval, upload clean inputs and use the H3 guard. Persist every submission intent and returned request ID before further work. Retrieve, download and continuously inspect clips. Record known terminal/QC evidence before an authorized retry. Changing attempt or authorization IDs cannot recover an uncertain submission.

Before assembly, build a per-shot execution reconciliation from the approved package, delivery receipts, local outputs, project assets and placed timeline items. Record the planned execution, actual source path/asset ID, actual media kind and QC state. Distinguish provider-generated video, deterministic Motion Graphic/video and editorial still in both the ledger and user-facing summary. A storyboard card, contact sheet or image with a slow push never proves that a video was generated. A planned deterministic animation is not fulfilled by placing only its static keyframe unless the user accepted that exact fallback. Do not search another project for a same-named clip as a substitute; matching provenance and shot intent are required.

Creative contract changes renew only affected shots. Prompt-only clarification can remain internal under the reviewed policy; compare meaning explicitly and record the prompt hash and rationale.

## Autonomous assembly and Gate 3

Final-cut review also takes place in ChatCut Desktop. Verify the editable timeline, captions, audio transitions and other packaging before presenting Gate 3. Do not add a Jianying handoff gate.

Import checked takes, trim to usable action/hold windows, place B-roll to source anchors and recompute actual coverage. Add deterministic text/diagrams, A-roll treatment, rights-suitable instrumental BGM and sparse event-linked SFX. Follow runtime-and-qa.md for source checks, sound level verification and continuous transition QA.

Place real historical examples at the speech span whose claim they evidence, such as failed cover variants under narration about repeated cover redraws. Do not move those examples into an unrelated B-roll-generation or timing claim just to increase visual variety. If a requested dynamic beat has no matching generated video, either complete its already-approved deterministic animation, reuse a separately proven semantically matching asset without mislabeling it, or return only the affected new generation scope to Gate 2.

Maintain the per-shot and packaging evidence defined in [assembly-evidence.md](assembly-evidence.md). Complete the actual placement, BGM, event-linked SFX, purposeful transitions/effects, keyword treatment, grade and rendered mix checks within the approved edit scope; select suitable licensed/local audio internally. Do not add a material-import, music-audition or effects-approval gate. A deliberate omission needs its recorded editorial reason; missing tools/assets is a blocker, not “not applicable”. New paid scope still needs authorization.

Prepare the editable final timeline with a playable review surface. Only after BGM/SFX are placed and the mix is checked, record the export with `review=true` (or `mark_ready`); the founder then approves any version in 「等你拍板」. Summarize meaningful choices, actual coverage, audio/visual QA and remaining tradeoffs. Do not claim a static screenshot proves the mix or motion.

Corrections remain in this edit/QA loop. Return to Gate 2 only for new material creative/generated content or changed paid scope. After Gate 3 approval, track final export through download and decode/audio checks; a submitted export is not delivery. Cover preparation and export retrieval may run independently.

## Gate 4 — both cover drafts together

Use the matching AutoCrew content record when available, otherwise the current real final script/SRT. Do not select unrelated “latest” content or silently create new copy. Missing content registration is not a blocker to local cover generation.

Default to Codex built-in `image_gen`, using subscription quota and targeting Image 2.5. Read imagegen and cover-generator first; no cash allowance is required for this route.

1. Generate three 3:4 candidates; internally select the strongest topic/identity/layout match. Do not add a user candidate-selection gate or endlessly regenerate for novelty.
2. View that master and use it as the built-in edit target for a separately planned 4:3 composition. Reposition the same portrait, headline, subtitle and thematic graphics for horizontal reading, preserving the face, current hairstyle, glasses, expression and natural body proportions. Do not stretch the person, regenerate a different face, or shrink the portrait cover into the center and merely extend its background. Keep the original copy; do not invent mask parameters or promise pixel protection if unavailable.
3. Inspect both at full resolution, face crop and thumbnail size. Present the pair with actual generation provenance. Record `model_requested="Image 2.5"`; `model_reported` is the returned value or null with an explicit unknown, never fabricated. Lack of model disclosure does not force a paid API switch.
4. Record the pair in one call — `autocrew_content record kind=cover paths=[<3:4>, <4:3>]` — so AutoCrew treats them as one group; the founder picks it in 「等你拍板」. Only after actual paired approval save approval evidence for both hashes and deliver both copies. AutoCrew registration is conditional on an actual supported import/registration path; do not call `approve` to pretend an external image is an existing candidate.

After every generated/revised pair and approval, use lifecycle `project_entry.py` to refresh this video's visible `封面/` pair and navigation, preserving the real pending/approved state. Save authoritative images and prompt/provenance records inside this video's folder first. Deliver direct links to both pickup files and the titled project folder, not just global generation outputs or deeply nested version locations.

Only when the user explicitly chooses a paid AutoCrew API route: verify live provider/model/price/cap authorization and tool schema, then use `draft_ratios` with the explicit candidate and `ratios=["4:3"]` for pending pairs. If absent, report that API capability gap; it does not block the default built-in route. Never pre-approve 3:4 to unlock `platform_ratios` or call an unexposed action. A local Skill change does not update the service's backend.

A changed 3:4 master invalidates its derived pair. A cover correction returns only Gate 4 to review, not the video. Keep the previously approved pair recoverable until its replacement is approved.

## Deliver and retain

Require the final downloaded checked video, final SRT, both approved covers, editable timeline reference and private receipts/QC records. Disclose any unavailable portable project export. After final-cut and cover approval, a user request to archive the identified project means NAS backup only (one `rsync -c` comparison, nothing deleted locally). 清本地 is separate: only an explicit request starts the lifecycle cleanup procedure, including project-owned ChatCut browser media, and that request is the whole deletion authority — do not ask twice. Approval alone triggers neither. Publication remains separately authorized. When cleanup was requested, continue through cleanup verification or record the exact blocked subset.
