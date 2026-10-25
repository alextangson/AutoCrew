# Editorial quality and effective visual coverage

## Semantic coverage, not footage quota

Read the complete approved rough-cut SRT and representative A-roll. Use that timeline's ID, revision, FPS and duration, not an older rough cut's timing.

Classify beats as `aroll`, `broll`, `mixed` or `keyword`. Full B-roll counts; mixed counts only when explanation is visually dominant and the viewer can follow the process/comparison. Tiny picture-in-picture, subtitle, watermark, keyword and decorative layers do not count.

Report union duration separately for full-frame B-roll, explanation-dominant mixed, and their combined union. Avoid double-counting overlapping intervals.

Every Gate 2 review page must display these durations **and percentages of the current cut's total duration** in its top summary, together with the remaining A-roll/keyword-only duration and percentage. State the denominator, timeline revision and whether the numbers are planned or verified from the actual placed timeline. Split mixed shots into their actual full-frame, dominant-composite and creator-led spans; do not classify a whole shot by its title. Save the frame-interval input and coverage audit output with the versioned review. Keyword-only layers, subtitles and tiny PiP contribute zero effective coverage. For a non-overlapping breakdown, assign simultaneous full-frame and mixed time to the visible full-frame layer; use the union for the combined total.

There is no coverage target: the user decided on 2026-09-29 that how much B-roll a video gets follows its content, not a fixed band. Decide beat by beat — B-roll where the viewer needs a picture to follow (an unfamiliar concept for a non-technical audience, a mechanism, numbers, a contrast, a structure they should remember); A-roll where the creator's experience, judgment or address to the viewer carries the beat. The coverage number is a descriptive fact for the review, never the reason to add or drop a shot.

Use `scripts/audit_workflow.py coverage coverage.json`. Input uses half-open frame intervals `[start,end)`, `duration_frames`, `fps`, `timeline_id`, `timeline_revision` and `segments`. Each segment has `mode`, `start`, `end`; mixed requires `explanation_dominant: true` to count. That field is a director's evidence-backed judgment, not pixel-area inference by the script.

## Keep the creator present

Reserve A-roll for trust, feeling, responsibility, personal judgment and calls to action. Use B-roll to demonstrate a task, rule, consequence or comparison. Improve dense stretches where useful; do not insert an effect blindly every N seconds.

Choose the simplest medium that communicates:

- actual workflow/UI evidence when available and authorized;
- deterministic diagram, number, keyword or relationship;
- generated Xiaolu/Agent action when embodiment, causality or humor helps.

Half visual coverage need not mean half the runtime is paid generated footage. Estimate usable seconds after trimming; budget handles and rejected takes explicitly.

For this user's demonstration/presentation layer, follow [explainer-packaging.md](explainer-packaging.md) and inspect its Chatterfly reference before designing. Unify blue-grid paper-card art direction while varying the actual script-specific process, objects and layout. A beige mock form recolored blue is not a faithful adaptation; do not restyle authentic product UI into fabricated evidence.

## Cards must be editable scenes

Show actual first/result states, source claim, viewer takeaway, action, props, camera, post labels, entry/exit match and planned usable interval. Keep review labels outside clean inputs.

Reuse the visual bible and only approved library entries. A directory existing does not approve every outfit/expression. Do not revive legacy sketch/particle styles.

Humor should reinforce the source: blind efficiency, literal metaphor, scale mismatch or delayed reaction. One mechanism per beat with enough setup/payoff time; no universal 1–2 second joke length or arbitrary memes.

Read `minimax-h3-video-creator/references/director-prompts.md` for causal examples, endpoint prompts, semantic repair and continuous clip QA. It is the single prompt source; do not maintain another copy here.

## A/B transition grammar

Choose a visible match: gesture, screen direction, object, texture, foreground occlusion, paper edge or pencil line. Design it in the card and validate the actual assembled cut. An isolated exit frame is insufficient.

Do not force generated transitions where a straight cut, sound bridge or restrained graphic is clearer. Protect face, gesture and caption safe areas in mixed layouts.
