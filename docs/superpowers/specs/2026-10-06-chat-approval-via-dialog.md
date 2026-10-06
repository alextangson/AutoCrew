# Chat approval via native dialog (等你拍板 in conversation)

Status: founder-confirmed scope and edges 2026-10-06; Codex consult folded in (see §Codex consult).

## Goal

The founder handles 等你拍板 items from the agent conversation instead of opening the :4317 web board. The agent shows the item in chat, the founder says what they want, and approvals are sealed by a macOS system dialog the server raises — the same trust model as the P6 handoff `confirm` (`src/modules/video/handoff/confirm.ts`, `dialog.ts`): chat text can be written by a model, a click in a server-raised GUI dialog cannot.

## Scope (v1)

Item types: `cover_pick`, `candidate`, `cut_review` only. Publish items (`publish_check`, `publish_claim`), `inbox_file`, `ask`, `sliver`, `other` stay web-only in v1 — the tool lists them with a board deep link, never decides them.

Two classes of action:

| Class | Actions | Needs dialog |
|---|---|---|
| Approve / state-changing | `pick_cover`, `confirm_candidate`, `approve_cut`, `reject_candidate` (不是), `retire_cover_group` (这组不要了) | yes |
| Revision request | `reject_cover` (还要改…), `reject_cut` (还要改…) | no — recorded from chat as an agent-reported request with the founder's quote |

Rationale: a forged revision request costs one extra round and changes no fact. `reject_candidate` flips a fact to rejected and `retire_cover_group` retires a group, so a forged one could hide legitimate work — those go through the dialog (Codex consult #4; narrows founder decision 1 of 2026-10-06).

## Surface

One MCP tool (name TBD in build, e.g. `autocrew_review_inbox`), both hosts (Claude Code, Codex):

- `list` → current items (reuses `readInbox`), each with item_id, gen, type, summary, content title, the server-derived facts the founder needs (cover text, group label, version, file names, reason), and a board deep link. Out-of-scope types are listed with `chat_decidable: false` + link.
- `send_back {item_id, gen, action, selector, founder_words, note}` → revision requests only; no dialog; requires non-empty `founder_words` and `note`. Recorded as agent-reported (provenance visible on the board), through the same CAS path.
- `confirm {item_id, gen, action, selector, params?, founder_words, request_id}` → raises the dialog, decides only on click.
- `selector` = explicit `group_id` / `fact_id` whenever the item holds more than one group or version; missing on an ambiguous item → refuse. Preview, dialog text and commit are bound to that selection.

The web board stays as-is.

## Dialog rules

1. Dialog text is generated server-side from the item's current state (re-read under the same gen check), never from agent-supplied prose. Agent-supplied values that become part of the decision (e.g. `cover_text`) are shown verbatim in the dialog.
2. Dialog shows which host/session requested it.
3. Buttons: 取消 / 查看 / 确认. 查看 opens the real file(s) (Preview for covers, QuickTime for cuts/aroll) resolved server-side from the fact's recorded path + sha256; never an agent-supplied path. Preview does not write anything; the dialog re-opens after preview (timer restarts, hard cap as in handoff confirm).
4. `cut_review`: 确认 is not offered until 查看 has been used at least once in this dialog session (founder rule: cuts are judged by watching).
5. One item per dialog (no batch in v1).
6. Click 确认 → `decideItem` with the item_id+gen captured before the dialog; decision `source` marks chat+dialog, and the founder's chat quote is stored with it.

## Edge cases (acceptance list)

Forgery / trust
- E1 Dialog content never taken from agent text; verified by test that a misleading agent description doesn't appear and server facts do.
- E2 Agent-supplied cover_text / note shown verbatim in dialog.
- E3 Requesting host/session shown in dialog.
- E4 Agent induced by page/file content to call confirm: nothing is recorded without the click (covered by E1 + dialog gate).
- E5 `send_back` without founder_words → rejected.

State
- E6 Item gen changed between chat view and confirm (e.g. new cover group arrived) → refuse before raising dialog, return fresh item for the agent to re-show. Also re-check after the click (gen may change while dialog is open) → refuse, record nothing.
- E7 Already decided on the web → "已在别处处理", no dialog.
- E8 Same request_id retried → same result, no second dialog.
- E9 Second confirm for the same item while a dialog is open (any session) → `dialog_busy`. Only one chat-approval dialog on screen at a time globally.

No click / cancel / away
- E10 5 min no click → `confirm_timeout`, nothing recorded; agent tells the founder.
- E11 取消 → `confirm_declined`, nothing recorded; agent asks what to change.
- E12 Not macOS / no GUI session / locked → `confirm_unavailable` with the item's board deep link as fallback.

Content
- E13 File behind the item overwritten / sha mismatch → refuse (existing `replaced_at` / sha guards).
- E14 查看 fails to open a file → dialog says so; for cuts 确认 stays unavailable.

Record
- E15 Decision record carries `source` (chat+dialog or chat send-back) and `founder_words`.
- E16 Web board flow unchanged; existing founder_only refusal for model calls stays for every other path.

## Non-goals

Batch confirm, publish items, inbox_file assign, editing cover text inside the dialog (the founder says the text in chat; it is shown verbatim for confirmation).

## Codex consult (2026-10-06) — folded in

1. Trust boundary, stated honestly: the dialog proves a click in the founder's GUI session. An agent with computer-use / GUI automation, or raw write access to the library, can defeat it — same residual risk as the existing handoff confirm and the web token. v1 accepts this residual; agent instructions forbid driving AutoCrew dialogs, and the tool description says so. No claim beyond that.
2. Privileged path: no caller-controlled `confirmed` flag. A private server function commits only from a dialog result bound to (item_id, gen, action, selector, normalized params, effective values). Type/action allowlist enforced server-side. Requester identity comes from the MCP transport context (host), not from params.
3. Fresh bytes: hash the selected cover/cut files before preview and again before commit; mismatch → refuse (E13). Preview opens an immutable copy under the cache dir named by sha, so the bytes viewed are the bytes hashed.
5. Selectors — see Surface.
6. Effective values resolved once on the server (e.g. effective cover text = explicit param, else group text, else handoff text), shown in the dialog, and committed exactly (explicit param to the decision, never re-derived).
7. Durable request records keyed by request_id, bound to a payload hash: states pending → dialog_open → committed | declined | timeout | unavailable. Same id + same payload → replay result; same id + different payload → `request_conflict`. Committed-but-response-lost is recovered by replay. Pending/dialog_open older than the hard cap are expired on startup.
8. Dialog slot is a separate global lock (one dialog on screen), never held together with the production/ownership lock. Flow: validate → take dialog slot → release → dialog → re-take commit lock → revalidate gen + bytes → commit. Slot is released on every exit path and cleared on startup.
9. "查看 succeeded" = the opener launched on the verified immutable copy without error; it does not prove watching. Locked screen is treated like no click (timeout) unless osascript reports no GUI (unavailable).
10. Decision schema: add `source: "chat-dialog" | "chat-reported"` alongside existing values and `founder_words` on the decision, written in the same push (not a later patch). Agent-supplied quotes are labeled unverified for revision requests; for dialog decisions the dialog shows the quote the founder confirms.

## Revision 2026-10-06 (later): drop the dialog — chat words decide

After a real run the founder found the text-only dialog pointless ("看不到东西") and chose to let chat decisions stand on their own, knowingly giving up the dialog's anti-forgery seal (risk stated once; founder decided). This supersedes the dialog parts above.

- All in-scope decisions (cover_pick, candidate, cut_review — approve, reject, retire, revision request) are recorded directly from chat. No dialog, no 查看, no preview copies, no dialog slot. Delete that code; no flag.
- Both hosts (Claude Code and Codex) may record them.
- Kept: exact item_id + gen + selector (group_id / fact_id) binding; selector_required on ambiguous items; gen change → refuse and return the fresh item; already-decided → 已在别处处理; request_id idempotency with payload binding; fresh sha check of the selected files before commit; effective values resolved once and committed exactly.
- Every chat decision stores verbatim `founder_words` (required, non-empty) and requested_by; source `chat` (replace chat-dialog / chat-reported with one value, migrate readers; existing records with the old values stay readable). Board shows the 对话里定的 / 对话里转述 label where the founder sees decisions.
- Cut approvals: the tool returns the cut file path in `list` and its description tells the agent to give the founder the file and ask them to watch before deciding (not enforceable).
- Revoke: expose the existing `revoke_approval` decision through the same tool so the founder can say 撤回刚才那个 in chat. No new UI.
- Publish items, inbox_file, ask, sliver stay web-only.
