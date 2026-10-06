/**
 * 对话确认的系统窗（chat-approval §Dialog rules）：取消 / 查看 / 确认。
 * - 「查看」打开核过字节的只读副本，不写记录；看完确认窗重新计时（5 分钟），整次硬上限 20 分钟（同交接确认）；
 * - 成片要先「查看」成功过一次才给「确认」按钮；打不开就在窗顶写原因，成片的「确认」仍然不给（E14）；
 * - 没人点 → confirm_timeout；取消 → confirm_declined；弹不出来 → confirm_unavailable（E10–E12）。
 * 弹窗走注入的 DialogRunner（pullDeps().dialog），测试绝不弹真窗。
 */
import { CONFIRM_HARD_LIMIT_MS, CONFIRM_TIMEOUT_MS } from "../../video/handoff/confirm.js";
import type { DialogOutcome } from "../../video/handoff/dialog.js";
import { pullDeps } from "../../video/handoff/pull-deps.js";
import { openForReview } from "./files.js";
import type { RequestState } from "./requests.js";
import { dialogText, type DialogFacts } from "./view.js";

const TITLE = "AutoCrew 等你拍板";
type Result = Record<string, unknown>;
export type DialogResult = { ok: true; text: string } | { ok: false; state: RequestState; result: Result };
type Clock = { deadline: number; hardStop: number };

const secondsLeft = (c: Clock) => Math.max(0, Math.floor((c.deadline - pullDeps().now()) / 1000));

function failure(outcome: DialogOutcome<unknown>, clock: Clock): DialogResult | null {
  if (outcome.kind === "ok") return null;
  if (outcome.kind === "timeout") {
    const tooLong = clock.deadline >= clock.hardStop;
    return { ok: false, state: "timeout", result: { ok: false, code: "confirm_timeout",
      error: tooLong ? "看了太久（超过 20 分钟），这次什么都没记。" : "5 分钟内没人点弹窗，这次什么都没记。",
      next_action: "告诉创始人弹窗过时了、什么都没记；他回到 Mac 前时再用新的 request_id 调一次 confirm。" } };
  }
  if (outcome.kind === "cancel") {
    return { ok: false, state: "declined", result: { ok: false, code: "confirm_declined", error: "创始人在弹窗里点了取消，这次什么都没记。",
      next_action: "问创始人想怎么改，别再原样弹一次。" } };
  }
  return { ok: false, state: "unavailable", result: { ok: false, code: "confirm_unavailable", error: `这台机器弹不出确认窗（${outcome.reason}），这次什么都没记。`,
    next_action: "把 board_link 给创始人，请他在看板上点；对话里的原话不能当确认。" } };
}

/** 成片：要先看过才给「确认」 */
const mustView = (f: DialogFacts) => f.item.type === "cut_review";

export async function runConfirmDialog(f: DialogFacts, dataDir: string): Promise<DialogResult> {
  const began = pullDeps().now();
  const clock: Clock = { deadline: began + CONFIRM_TIMEOUT_MS, hardStop: began + CONFIRM_HARD_LIMIT_MS };
  let viewed = false;
  let notice: string | null = null;
  for (;;) {
    if (secondsLeft(clock) <= 0) return failure({ kind: "timeout" }, clock)!;
    const gated = mustView(f) && !viewed;
    const text = dialogText(f, notice, gated);
    const buttons = gated ? ["取消", "查看"] : ["取消", "查看", "确认"];
    const answer = await pullDeps().dialog.ask({ title: TITLE, prompt: text, buttons, defaultButton: buttons.at(-1)!, cancelButton: "取消", timeoutSec: secondsLeft(clock) });
    const failed = failure(answer, clock);
    if (failed) return failed;
    const clicked = (answer as { value: string }).value;
    if (clicked === "确认" && !gated) return { ok: true, text };
    notice = await openForReview(f.item.content_id ?? "", f.selection.factIds, dataDir);
    if (!notice) viewed = true;
    clock.deadline = Math.min(pullDeps().now() + CONFIRM_TIMEOUT_MS, clock.hardStop);
  }
}
