# Visual review for collected and generated B-roll

Use this format when presenting material to collect, candidate real footage, AI storyboard/generation proposals, or completed insertions. The review is a browsable local page with large images/playable clips, warm paper background, restrained blue accents, clear Chinese labels, and `#real`, `#ai`, `#sound`, `#gaps` navigation. Keep the creative explanation beside the picture. Do not substitute a text checklist or a contact sheet for individual scene cards.

## Content that changes decisions

- Every storyboard review page must show **分镜覆盖率** near the top: the current cut's total duration, full-frame B-roll seconds/percentage, explanation-dominant mixed seconds/percentage, their combined union seconds/percentage, and the remaining A-roll/keyword-only seconds/percentage. Identify the timeline revision and state whether this is planned coverage or verified placed coverage. Use the frame-interval calculation in [director-quality-bar.md](director-quality-bar.md); do not use shot count, summed overlapping durations, or count subtitles, keywords and tiny PiP as effective coverage. Split a shot when its visual mode changes. Coverage describes the plan, never sets a quota.
- Every item: stable shot ID, real/AI/mixed kind, truthful status, exact speech span/quote against the current cut, visual purpose, entry/action/result/exit, actual preview and proposed or actual placement.
- Collected material: source page, creator and usage/license evidence, actual demonstrated action, limits of that evidence, source trim/crop/audio treatment. Distinguish official demo, personal capture, repository screenshot, marketing illustration and conceptual recreation. A screenshot is not an operation recording; official availability is not blanket reuse permission.
- AI proposal: actual start/result boards and separately labelled clean input/reference images, identity/style reference, causal action, exact prompt, endpoint, chosen parameters and reference-price source date (H3 uses its shared price-estimates.md; label costs as estimates), per-attempt estimate, max attempts, objective retry conditions, first-pass total and worst-case cap. Owner-specific request fields stay in the generation Skill's guarded manifest. No fixed provider, shot count, price or duration comes from this display template.
- AI result: playable delivered video, actual attempt/outcome, technical/visual QC, final composited version where different, and actual insertion span. Label unresolved human review separately. A still or push-in is not a generated video.
- Sound when relevant: playable music/SFX or mix, provenance/credits, gain/timing and whether listening actually happened. Decode/loudness checks do not establish subjective audition.
- `#gaps`: missing footage, unsupported claims, chosen fallback and what remains for user inspection. A placeholder says what is missing; it never impersonates a real result.

Keep early collection candidates lightweight; defer unknown AI costs/parameters explicitly instead of inventing them. Complete execution-critical facts before requesting paid-generation approval.

## Produce and preserve

Use `scripts/build_material_review.py` from this Skill with a project-local JSON display manifest:

```bash
python3 <skill>/scripts/build_material_review.py <project>/03-broll/review-v001/display.json --root <project> --output <project>/03-broll/review-v001/review.html
```

Then report it: `autocrew_content record kind=storyboard path=<project>/03-broll/review-v001/review.html request_id=<new id>`. AutoCrew accepts only a page in the content's own `03-broll/review-vNNN/` whose sibling `review.receipt.json` matches the page and media bytes; the founder opens it from 「打开审阅页」 on the card. If it is rejected, follow the message (usually: re-render into the next `review-vNNN`); never hand-edit the HTML or send a Markdown storyboard instead.

The renderer validates local media paths and any supplied SHA-256 hashes, escapes text, uses no CDN and refuses to overwrite an existing page or receipt. It does not upload, generate, insert, submit or approve anything. All media paths resolve relative to `--root`; output must be inside that root. Serve the root on loopback only if browser preview requires HTTP; keep relative links portable. Before exposing previews, remove account details or private content from the actual derivative bytes, not only with CSS.

The compact display schema is deliberately separate from provider/approval schemas:

Put the computed coverage values and calculation basis in `summary` so the existing renderer displays them at the top. Keep the frame-based input and audit output beside the display manifest. If timings are unresolved, label the missing coverage explicitly and resolve it before presenting the timed storyboard for approval; never invent a percentage. Add a coverage-only supplement as a new version rather than overwriting an approved review page. Unchanged creative approval remains valid.

```json
{
  "title": "片名 · 素材审阅", "version": "v001", "intro": "本次想让观众看到什么",
  "summary": {"状态": "待审", "首轮估算": "待核实", "费用上限": "待授权"},
  "items": [{
    "id": "S01", "kind": "real", "title": "真实操作", "status": "待收集",
    "timing": "00:12.000–00:18.000", "quote": "对应口播原句",
    "purpose": "这段画面具体说明什么", "media": [],
    "facts": {"来源类型": "个人录屏", "计划画面": "输入→处理→可见结果", "仍缺": "实际录屏"},
    "links": [{"label": "来源页面", "url": "https://example.com"}]
  }],
  "gaps": ["S01 尚无录屏，暂用真人画面"], "notes": ["页面状态不代表批准"]
}
```

`kind` is `real`, `ai`, `mixed`, or `sound`. Each `media` entry has `type` (`image`, `video`, `audio`), project-relative `path`, `label`, optional `sha256`; clip previews default muted with controls. `facts` is an ordered label/value object (values may be strings, lists or objects). Optional `prompt` appears in an expandable section. AI items use `facts` for the complete proposal details above, not a product screenshot placeholder. Add multiple media entries for start/result/clean input/generated output and label their roles explicitly. Use current project data for a smoke demonstration; never bundle private footage into the global Skill.

When a page is shown for approval, retain its HTML, display manifest, source hashes and owning guarded manifest as an immutable snapshot. Record the user's actual reply against that version outside the page. No checkbox or generated label is consent. Existing scoped approval remains valid; this format adds no fifth review. After generation/insertion, write a new execution page referencing the approved snapshot and explaining changes. Never rerun a proposal builder over approval state or silently turn `pending` into `approved`.

Check local links/media, render the page at desktop and narrow widths, and inspect representative cards, source labels, costs and gaps. Report separately any unavailable media, unverified provider facts and pending human review.
