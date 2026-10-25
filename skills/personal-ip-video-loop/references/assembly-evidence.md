# Actual assembly before Gate 3

For a full edit authorized through Gate 2, continue to playable final-cut review without asking for another “导入/继续/配乐” instruction. A standalone generation-only or explicitly media-bin-only request stays within that scope. Same-turn execution is the default; a final promise does not create a background worker.

Reconcile the approved shot package with the current human-edited timeline and matching SRT. Insert checked media into the existing editor, then re-read its tracks/items and verify source, start/end and trims. Media-library counts do not prove placement. A timeout requires readback and reconciliation before retry; preserve a lightweight snapshot, never duplicate the entire draft. When no new flattened A-roll export exists, inspect the live editable timeline/source map first rather than treating an export as a prerequisite.

Complete these layers before review:

- Each planned shot mapped to its actual file/hash, media kind, asset ID and placed timeline item/range. Split placements belong under the same shot ID. Recompute effective coverage from the actual timeline.
- Reconcile the complete mixed selection map, including Xiaolu/provider scenes and motion; never replace that list with only the route whose files finished first. Record storyboard-only, generation-pending, generated and placed separately. For non-overlapping full-frame clips, verify a shared supplementary video track; additional layers need a real compositing purpose. Audit visible coverage and opaque overlaps, not merely whether each asset exists in a track.
- Purposeful A/B-roll transitions and emphasis effects, editable keywords/diagrams, source-based A-roll treatment. Straight cuts or no grade/effect can be a valid documented editorial decision; tool failures cannot be renamed as such.
- Rights-suitable BGM and sparse event-linked SFX, selected internally within existing authorization. Save source/licensing evidence under `05-audio`; no extra music audition gate. User-requested no-music scope overrides the default. Missing licensed media or unapproved costs require an authorized alternative or a precise blocker.
- Rendered mix and continuous playback checks, with actual intervals and findings. Gain values alone do not prove a good mix; screenshots/decoding alone do not prove motion or audio acceptance. An unchecked interval remains unfinished, not passed.
- A review video delivered inline in the conversation, corresponding to the recorded timeline revision, plus an editable editor reference. Follow the delivery contract below. Gate 3 is still human approval.

## Conversation video delivery

Apply this contract to rough cuts, motion samples and final cuts. Prefer native playable media already returned by the tool. For a local review video in Codex, confirm that the file exists and matches the intended version, then embed it in the user-facing reply:

```markdown
![精剪审片 v001](</absolute/project/07-delivery/精剪-v001.mp4>)
```

Use an absolute path; angle brackets preserve paths containing spaces. The leading `!` is required for media embedding. `[精剪审片 v001](<...>)` alone is a file link and does not satisfy this contract. Keep the version label next to the video. File-download links, HTML review pages, side panels and editable ChatCut project references may supplement the inline video, but must not replace it.

If the host cannot embed the video or an actual rendering failure is observed, state the specific limitation and provide the best available playable fallback. Do not silently downgrade to file-only delivery. Do not claim the inline player rendered successfully without observing it. Embedding does not establish playback QA or human approval. Do not upload private media elsewhere solely to create a player without authorization.

Copy `assets/assembly-record.json` to the host-owned `04-edit/assembly.json`, populate from actual evidence and run:

```bash
python3 scripts/audit_workflow.py assembly /absolute/project/04-edit/assembly.json
```

The auditor lists missing placement/packaging evidence and exits nonzero while incomplete. Populate `approved_shot_ids` from the approved package, not just the files that happened to finish. Paths are relative to `project_root`; evidence files must exist and be non-empty inside it. `shots` entries contain `shot_id`, `media_kind` (`provider_video`, `deterministic_video`, `editorial_still`), `source_path`, `source_sha256`, and `placements`. Each placement has `asset_id`, `item_id`, `start_frame`, `end_frame`, `verified`, `evidence_path`. Do not invent editor IDs; if the editor exposes none, retain the real UI evidence and report that this automated reconciliation is incomplete.

Every check has `status: pending|blocked|verified|not_applicable` and `evidence_path`; use `reason` for blocked/omitted layers. Only transitions/text/grade/BGM/SFX allow a deliberate omission; BGM also requires `user_scope_evidence_path` for the no-music request. Coverage, mix, continuous playback and playable review cannot be omitted. Read the cited evidence and compare its actual timeline revision, source/SRT hashes and ranges; this helper checks bookkeeping, not their truth or creative quality.

For independent workflow state, include this record as `assembly` when entering `finish`; `resume` checks it before returning `await_user_review` for Gate 3. For AutoCrew, run the standalone command and report its evidence path through the service; never modify service-generated workflow views to fit this schema. A ledger update never grants paid actions or human approval.

If a real blocker remains, finish independent in-scope work, save the failing operation/error and current editor revision, identify completed versus missing layers and the exact next action. Do not ask the user to approve unchanged scope, claim unattended continuation, or describe a materials page as a finished film.
