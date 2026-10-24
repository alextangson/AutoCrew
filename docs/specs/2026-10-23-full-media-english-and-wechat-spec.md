# Full-media: English dubbed edition (X + YouTube) and WeChat article from the cut

Status: draft, waiting on founder confirmation of the open points (§4) and the edge list (§5). Codex consult happens after that, before any build.

## 1. What the founder asked for (2026-10-23, own words condensed)

- Every video also ships an **English edition**: founder's **cloned voice**, best available model, **light localization** (keep the skeleton, swap examples/products a Western viewer wouldn't know), **16:9**, published to **X (Premium) and YouTube**.
- English edition starts **after the Chinese cut is approved — in parallel with cover work**.
- **Demo first** on past hit videos (files on NAS) to judge the effect before wiring it in.
- English subtitles: founder picks a style from options later.
- **WeChat 公众号 article** for every video: written **from the approved cut**, 2500–4000 chars, new research allowed, founder approves the draft **as a rendered illustrated page**. Images chosen per content — some real web material, some Codex Image 2.5. Article cover also Codex.
- Publishing: we **schedule** it, founder **scans the QR** to confirm, scheduled alongside the video's publish slots, ideally with the **视频号 video embedded** in the article.
- Both lines built together.

## 2. Facts this spec rests on (checked 2026-10-23)

- Delivered cuts are already 1920×1080 (16:9) — no reframing needed for YouTube/X.
- AutoCrew has no translation/dubbing/English-caption concept. Video platforms are hard-coded to four (`src/storage/stage-guard.ts:18`, `review-gate/platforms.ts:4`, plus scattered enums in `tools/*`).
- A video is one content item with per-platform publish kits (`videoKits`, `local-store.ts:398`). Text platforms are sibling items linked via `siblings`/`derivedFrom` (`tools/rewrite.ts`).
- `wechat_mp` already exists end to end: writer pack (`modules/packs/wechat-article.ts`), inline image markers + generation (`modules/publish/article-images.ts`), draft-box push via API (`modules/publish/wechat-mp.ts:357`). Missing: deriving from a cut, illustrated review, web-sourced images, scheduled 群发, 视频号 embed.
- Codex image path (`modules/publish/codex-image.ts`) cannot pass a model id. "Image 2.5" can only be requested in the prompt and verified afterwards via the reported model (same as `skills/cover-generator`).
- ChatCut offers two dubbing routes: (A) integrated `video_translation` — provider translates, keeps speaker's voice, optional lip-sync, target text editable before render; (B) Fish Audio voice clone (`manage_custom_voice`, needs Pro) → TTS → `submit_lipsync`. Light localization changes wording, so both are viable; B gives audition control per line.
- Video editing is done by Codex in ChatCut via the `personal-ip-video-loop` skill pack (outside repo, `~/.codex/skills`). Publishing clicks are done by the `publish-content` skill via ego-lite.

## 3. Proposed design

### 3.1 English edition (lives on the same video content item)

Flow after `videoDone` (Chinese cut approved):

1. **Localize script** (Claude, in the video's session): source = final cut transcript. Output a side-by-side zh/en script with every swapped example marked (`原例 → 替换例 + 理由`). Swapped examples obey the same evidence rules as Chinese drafts (no invented facts).
2. **Founder approves the English script** in chat (review inbox, new item type `en_script`) — reviewed on the Chinese side-by-side, so no English fluency needed.
3. **Codex dubs and edits** in ChatCut (handoff extension of the existing editing task):
   - voice: founder's clone, route chosen by the demo (§3.3);
   - lip-sync on A-roll segments only;
   - MG/title cards with Chinese text re-rendered in English (ChatCut MG is code);
   - Chinese screenshots/web pages in B-roll: kept, with an English caption bar (see §4 Q3);
   - burned-in English subtitles, style from the founder's pick;
   - English 16:9 thumbnail with founder in it, via Codex (cover-generator, English text).
4. **Founder approves the English cut** (existing `cut_review` with `edition: en`) — must listen: cloned voice quality is the main risk.
5. **Publish kits** `youtube` and `x`: English title/description/tags/chapters (YouTube), post text (X), thumbnail. Built by pre-publish like the four existing kits.
6. **Publish**: `publish-content` gains `youtube` and `x` manuals (YouTube Studio scheduled publish; X scheduled video post). Same receipt/confirm flow as the existing four.

Data (revised after Codex consult, §7 #1): the English edition is a **separate sibling Content item** (`lang: en`, platforms youtube+x), with durable lineage to the Chinese item's approved cut hash. It runs its own status/claim/registration/approval lifecycle, so it can never supersede the Chinese approval.

### 3.2 WeChat article (sibling content item, `platform: wechat_mp`, `derivedFrom: <video id>`)

1. **Trigger**: after `videoDone`, the video session derives a `wechat_mp` sibling. Source = cut transcript + the original research ledger.
2. **Research top-up**: allowed (scout), new quotes go through `verify_quote` like any draft.
3. **Write** with the existing wechat writer pack, plus a 公众号 hit-article method (title options, opening, sectioning, 2500–4000 chars). Title: 3–5 options for the founder.
4. **Images**, each marked in the draft as one of:
   - `web`: real material (official screenshots, product pages, charts from a cited source) — fetched/screenshot via ego-lite, saved with source URL, caption credits the source;
   - `gen`: Codex Image 2.5, prompt + reported model recorded;
   - cover: Codex, one center-safe master; 2.35:1 + 1:1 are crop regions of it (WeChat takes one thumb + pic_crop_235_1 / pic_crop_1_1; corrected in 2b).
5. **Founder review**: a rendered illustrated HTML preview (approximates WeChat layout) opened from the review inbox; approve / revise in chat as today.
6. **Publish**: push to draft box via API (existing) → ego-lite opens mp.weixin.qq.com → insert 视频号 card → set 定时群发 at the planned slot → stops at the admin QR → founder scans → receipt recorded.

## 3.3 English edition standard recipe (demo-verified 2026-10-23, founder approved)

Demo artifacts: `~/.cache/autocrew-yt/en-demo/` (`STATE.md`, final `route-D-captions-A.mp4`).

- **Script**: light localization; English runs 5–25% longer than Chinese, so write tight and keep per-segment budgets.
- **Voice**: ElevenLabs instant clone of the founder (Starter plan; key in macOS Keychain `autocrew-elevenlabs`; voice `E3xCuJvK3vXyJgMz1CqP`), model `eleven_v4`, settings stability 0.3 / similarity 0.8 / style 0.35 / speaker boost. Default settings sounded like a broadcaster. Next improvement: re-clone from a free-talk English recording instead of a read script.
- **Timing**: one TTS call per line, placed sequentially (never overlapping); leftover overrun absorbed by existing pauses, then the tail picture slowed ≤ 1.15×. No freeze frames under lip-sync.
- **Lip-sync**: ChatCut `submit_lipsync`, `preserve-video`; reference video must carry its original speech track and be < 50 MiB.
- **Captions**: style A (clean, Ali Abdaal-like) — Avenir Next Demi Bold 54 px, white, dark soft shadow, ≤ 2 lines bottom-center, ≤ 1 yellow keyword per cue, whole-cue in/out, text from the approved script, timing from word timestamps.
- **Operational constraints**: ChatCut paid generation only confirms with the ChatCut window open (otherwise auto-denied); background Codex (approval policy never) cannot run paid ChatCut generation; a ChatCut project accepts one MCP client at a time. → The English production step runs in a foreground session with the founder available to confirm, not as a background Codex job.

## 4. Founder decisions (2026-10-23)

- **Voice route**: decided by an ear test in the demo. Candidates: (A) ChatCut integrated `video_translation`; (B) ChatCut Fish clone + `submit_lipsync`; (C) ElevenLabs clone, only if the founder opts in to an ElevenLabs account. Price quoted before each paid render. Existing ChatCut clone "lawrence" (Pro, 1 slot) is still there; re-cloning from English needs deleting it first — ask before deleting.
- **Voice reference**: founder records ~2.5 min of English reading (`2026-10-23-voice-clone-reading-script.md`).
- **Chinese screenshots in B-roll**: keep + English caption bar; MG cards re-rendered in English.
- **English publish time**: Beijing 21:00–23:00 (US morning), not the Chinese slot.
- **视频号 embed**: article scheduled a few hours after the 视频号 video is live, same evening; insertion rule verified in ego-lite first.
- **Daily 群发 quota**: second article of the same day moves to the next day.
- **Web images**: official sources and our own screenshots of public pages only, credited. (Founder's "6 ok" read as covering this point too — confirm at review.)
- **Demo picks**: top by Douyin plays — 「一起搞懂Agent Harness」(324k) and 「深度思考开到max，AI反而更容易跑偏」(130k). Third-ranked 「Typeless年费/腾讯免费版」(94k) skipped: it's about China-only products, a poor localization test.

## 5. Edge list (becomes the acceptance list)

English edition
- Chinese cut re-opened after English work started → English edition marked stale, its approvals cleared, founder told; no silent publish of an English cut built from an old Chinese cut.
- Clone not available (no ChatCut Pro / consent missing / quota) → English edition shows a blocked state with the reason; the Chinese publish is never blocked by the English line.
- Localized line runs longer than the original segment → Codex re-trims wording or stretches B-roll; never time-stretches the founder's lip-synced face beyond a set limit (to be measured in the demo).
- Lip-sync artifacts (teeth/blur) → caught by the English cut review; cut review cannot pass without the founder's listen.
- A swapped example lacks a source → script review shows it as unverified; cannot be approved until sourced or removed.
- X video length: Premium allows long uploads; still check file size/duration limit at upload and fail visibly.
- YouTube/X not logged in in ego-lite → publish step stops and asks the founder to log in; no silent skip.
- Double publish: receipt check per platform before clicking, same as the existing four.

WeChat article
- Article draft written before the cut changes → marked stale like any derived item.
- Image generation fails / reported model isn't Image 2.5 → that image shows as failed or "model mismatch" in the preview; never silently replaced by a relay model.
- Web image source URL unreachable or license unclear → image marked, not inserted.
- API draft push fails (token, IP whitelist) → visible error with the raw message; no fallback to "copy to clipboard" without telling the founder.
- 视频号 video not live at article schedule time → article schedule waits; founder told.
- QR not scanned within WeChat's timeout → schedule not set; state stays "waiting for scan", retry available.
- Length outside 2500–4000 → review desk flags it; founder can override.

## 7. Codex consult (2026-10-23) — folded in

Raw output: `~/.cache/autocrew-yt/codex-consult/fullmedia-1023.txt`.

1. **English = sibling Content, not sub-record** (P1). Handoff/production gates select one approved cut per item (`handoff/gate-state.ts:55`, `production/publish-gate.ts:61`); a sub-record would fight the Chinese approval. → Adopted in §3.1.
2. **Approvals must bind artifacts** (P1): English script revision, source cut hash, rendered audio/cut hash, kits. Any upstream change invalidates downstream; an already-scheduled upload must be reconciled (cancel/replace) explicitly, not assumed cancelled. → Build item.
3. **Platform capability table instead of a bigger list** (P1/P2). Today the four-platform set is duplicated (stage-guard, review-gate `plan.ts:145`, `deterministic.ts:98`, frontend `lib.ts:341`, metrics `work-binding.ts:19`), and unknown platforms inherit 30-char CJK title, mandatory cover text, 3 cover ratios. → One `PLATFORM_CAPS` table: language, cover ratios (youtube/x = 16:9), title/caption counters (English counted by chars, not half-weight), required fields (YouTube tags/chapters, X post text), metrics = unsupported (explicit). Handoff/registration cover requirement (`handoff/register.ts:80`) becomes per-platform.
4. **WeChat scheduling + 视频号 card is browser-only and unproven** (P1). Repo only calls `draft/add` (`vendor/wechat-format/scripts/publish.py:219`). → Feasibility spike on the real account before building: schedule window, quota, card selection, QR flow.
5. **WeChat publish must be idempotent and recoverable** (P1): persist account, draft media_id, content hash, schedule, attempt state; a scan with lost response = "unknown", reconcile in the backend before retry.
6. **Approval binds the outgoing package** (P1): approved illustrated preview = hash of text + images + cover; publish refuses if the draft-box content differs, and must not fall back to another cover (`wechat-mp.ts:387`). Card insertion after approval is the only allowed delta, verified after.
7. **Derivation lineage doesn't exist yet** (P1): `rewrite` reads the body, not the cut transcript, and `derivedFrom` is dropped before storage (`tools/rewrite.ts:67,130`). → Durable `derivedFrom {contentId, cutHash}` + idempotent derive (re-run = same sibling), staleness computed from it.
8. **WeChat length limit is 3000 today** (`publish-limits.ts:62`) → raise to 4000 for wechat_mp.
9. **"Image 2.5" can't be verified** (P2): Codex adapter returns bytes only (`codex-image.ts:56,95`). → Record provider=codex + requested model; show "model unverified" honestly. Founder to accept or pick a verifiable relay model.
10. **Existing invariant violations in reused code** (P2): `prepareVideoKit` calls the relay directly (`video-kit.ts:94`); storyboard parser and `batch_adapt` reject stringified arrays (`video-kit.ts:183`, `rewrite.ts:143`). Fix where reused.
11. **Demo needs editable sources** (P2): a final MP4 has burned-in Chinese captions and flattened MG. → Demo on 「深度思考开到max」 first (ChatCut project exists); Harness (Aug, pre-ChatCut) needs a rebuild from raw A-roll + screen recordings. Localization review = segment-mapped bilingual review, not just side-by-side text.

### 7a. WeChat feasibility spike — results (2026-10-23, account 哈姆雷鹿, ego-lite, nothing published)

- **视频号 card**: editor toolbar 视频号 → search any 视频号 or pick from 最近使用 (哈姆雷鹿 listed; binding not required, binding only skips the search). Lists published videos newest-first; up to 10 per article. Unverified: whether a scheduled-but-not-yet-live 视频号 video appears → design assumes only live videos can be inserted.
- **Creation-source declaration (new, required)**: clicking 发表 first prompts for 创作来源 per 《人工智能生成合成内容标识办法》: 内容由AI生成 / 素材来源官方媒体/网络新闻 / 剧情演绎 / 个人观点 / 健康医疗 / 投资观点 / 无需声明. Articles with Codex-generated images must declare 内容由AI生成 (or the right type); "无需声明并发表" must never be clicked by automation. → publish pack carries a `creationSource` field, founder confirms it in the illustrated review.
- **Cover is mandatory** to publish; cover editor crops two ratios: 2.35:1 (message list) and 1:1 (share card / profile).
- **Publish dialog**: 群发通知 (shows remaining daily count, "今天还有1次通知次数"), 分组通知, 定时发表 (date today … +6 days, minute-level time). Matches the daily-quota rule (Q6).
- **Not reached (by design)**: the final 发表 click and the admin QR scan. Whether scheduling with 群发通知 triggers the QR at schedule time is expected but unverified; the first real article is the verification run, founder present.
- Side effect: the test auto-saved a draft "【测试勿发】定时群发实测" (appmsgid 100002022) with an arbitrary library image as cover; not published.
- API vs browser: scheduling, 群发通知, 视频号 card and declaration all live in the web editor; the repo's API path only creates drafts → publish step = API draft + ego-lite finishing, as designed.

**Build order:** (a) feasibility: one English demo + WeChat schedule/card spike on the real account → (b) shared foundation: lineage, artifact-bound approvals, platform capability table, recoverable publish state → (c) English slice and WeChat slice in parallel → (d) Chinese-publish regression tests throughout.

## 8. Build phases (proposed 2026-10-23, awaiting founder confirmation)

**Phase 1 — shared foundation (no user-visible flow change; existing four platforms must behave identically):**
1. `PLATFORM_CAPS` single table: kind (video/article), language, cover ratios, title/caption counter (CJK-weighted vs plain chars), required kit fields, metrics support (explicit `unsupported`), publish channel. All scattered lists (stage-guard, review-gate, pre-publish, ego-lite, data-page, flywheel bindings, frontend `lib.ts`) read from it. Add `youtube` and `x` (en, 16:9 cover, plain char counting, metrics unsupported). `wechat_mp` body max 3000 → 4000.
2. Durable lineage: `Content.derivedFrom = { contentId, kind: "en_edition" | "wechat_article", sourceCutHash }` persisted (not dropped like rewrite's provenance); `deriveSibling(sourceId, kind)` is idempotent (second call returns the existing item); `isStale(item)` = source's current approved-cut hash ≠ `sourceCutHash`, surfaced on the board/inbox as a visible state.
3. Artifact-bound approvals helper: an approval stores the hash of what was approved; consumers re-check the hash before acting and refuse with a visible reason on mismatch.
4. Platform opt-in (founder addendum 2026-10-23): onboarding/settings platform checkboxes come from `PLATFORM_CAPS` (adds YouTube, X); a line only runs for picked platforms — WeChat article iff `wechat_mp`, English edition iff `youtube` or `x` (kits only for the picked ones); `deriveSibling` refuses visibly otherwise. Legacy `twitter` in profiles = `x` (superseded by §9.3: twitter no longer opens the English line). New platforms are opt-in for existing profiles; changing the selection never deletes derived items.
- Acceptance: regression tests proving the four existing platforms' kits, gates, cover ratios and limits are unchanged; tests for youtube/x caps, lineage idempotency and staleness, approval hash mismatch.

**Phase 2 — WeChat article slice:** derive from approved cut transcript + research ledger; scout top-up with verify_quote; writer pack with hit-article method (3–5 titles, 2500–4000 chars); image plan with per-image provenance (`web` source URL+credit / `gen` Codex requested model, "model unverified" shown honestly) and `creationSource` declaration; illustrated HTML preview approval bound to package hash; Codex cover 2.35:1 + 1:1; publish = API draft (persisted media_id/hash/attempt state, idempotent) + ego-lite manual for declaration, 视频号 card (only live videos), 定时群发 at the planned slot, stop at admin QR, reconcile unknown outcomes.

**Phase 3 — English slice:** `en_edition` sibling; localized side-by-side script review; ElevenLabs TTS module (key from settings/env `ELEVENLABS_API_KEY`, checked by `autocrew doctor`; macOS Keychain only as a local convenience); editing recipe §3.3 written into the editing skill as a foreground step; English 16:9 thumbnail via cover skill; youtube/x kits; publish-content manuals for YouTube Studio + X scheduled posts.

## 6. Deliberate exclusions (v1)

- No metrics pull-back for YouTube/X (AutoCrew analytics stays on the four Chinese platforms + 公众号).
- No YouTube Shorts / vertical English cut.
- No English edition of the 公众号 article; no other languages.
- No automatic reply/community management on X/YouTube.

## 9. Founder decisions after end-to-end verification (2026-10-24)

1. **Source recut → rebind, not redo.** When the Chinese cut is re-approved as a new version, a derived item offers `rebind`: keep the existing script/images/thumbnail as drafts, bind to the new cut, show a transcript diff (old vs new cut SRT). WeChat article: founder reviews the diff and re-approves. English edition: only changed segments are re-dubbed; lip-sync and captions are redone on the new cut (picture changed); script + package re-approved.
2. **Unpicking a platform stops in-flight lines.** If the founder unpicks 公众号 / YouTube / X, items of that line can't publish anywhere (visible reason on board and exits); re-picking resumes. No auto-delete.
3. **Legacy `twitter` no longer opens the English video line.** It keeps meaning text posts (twitter-post pack). The English line requires an explicit `x` or `youtube` pick; existing profiles with `twitter` get a visible prompt to pick X/YouTube explicitly.
