/**
 * 创始人 Mac 上的系统确认窗（P6 §12.2-2、§12.4-C）。
 *
 * 为什么是系统弹窗：对话里的「对」「封面字写 X」模型也写得出，服务端分辨不出；
 * 弹窗是服务端自己在创始人的 GUI 会话里弹的，点的人只能是坐在 Mac 前的人。
 *
 * 实现走 `osascript`，数据一律经 `on run argv` 传进脚本，不拼进 AppleScript 源码（不用转义、不怕注入）。
 * 这是注入口：测试换假的，绝不弹真窗。
 */
import { runProcess } from "../proc.js";

export type DialogOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "cancel" }
  | { kind: "timeout" }
  | { kind: "unavailable"; reason: string };

export interface DialogRunner {
  /** 列表单选：返回选中的那一行文字 */
  choose(opts: { title: string; prompt: string; items: string[]; defaultItem?: string; timeoutSec: number }): Promise<DialogOutcome<string>>;
  /** 按钮对话框：返回点中的按钮文字；`cancelButton` 点了算 cancel */
  ask(opts: { title: string; prompt: string; buttons: string[]; defaultButton: string; cancelButton: string; timeoutSec: number }): Promise<DialogOutcome<string>>;
  /** 带输入框的对话框：返回改过的文字 */
  input(opts: { title: string; prompt: string; defaultAnswer: string; timeoutSec: number }): Promise<DialogOutcome<string>>;
}

const NO_GUI = /no user interaction allowed|-1713|not authorized|-1743|connection is invalid|can.t get application/i;

type Raw = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };

function classify(raw: Raw): DialogOutcome<string> | null {
  if (raw.spawnError) return { kind: "unavailable", reason: `osascript 起不来：${raw.spawnError}` };
  if (raw.timedOut) return { kind: "timeout" };
  if (raw.code !== 0) {
    if (/-128|user canceled/i.test(raw.stderr)) return { kind: "cancel" };
    if (NO_GUI.test(raw.stderr)) return { kind: "unavailable", reason: `没有可用的图形会话：${raw.stderr.trim().slice(0, 200)}` };
    return { kind: "unavailable", reason: `弹窗失败：${raw.stderr.trim().slice(0, 200) || `退出码 ${String(raw.code)}`}` };
  }
  return null;
}

async function osa(lines: string[], args: string[], timeoutSec: number): Promise<Raw> {
  if (process.platform !== "darwin") return { code: null, stdout: "", stderr: "", timedOut: false, spawnError: "不是 macOS" };
  const script = ["on run argv", ...lines, "end run"].flatMap((l) => ["-e", l]);
  return runProcess({ command: "osascript", args: [...script, ...args], timeoutMs: (timeoutSec + 5) * 1000 });
}

/** `display dialog` 的输出：button returned:X, text returned:Y, gave up:true|false */
function field(out: string, name: string): string | null {
  const m = new RegExp(`${name}:(.*?)(?:, (?:button returned|text returned|gave up):|$)`, "s").exec(out.trim());
  return m ? m[1] : null;
}

export const osascriptDialog: DialogRunner = {
  async choose({ title, prompt, items, defaultItem, timeoutSec }) {
    // choose from list 没有 giving up after：靠进程超时收掉窗口
    const raw = await osa([
      "set theItems to items 3 thru -1 of argv",
      "set picked to choose from list theItems with title (item 1 of argv) with prompt (item 2 of argv) default items {item 3 of argv}",
      "if picked is false then error number -128",
      "return item 1 of picked",
    ], [title, prompt, ...(defaultItem ? [defaultItem, ...items.filter((i) => i !== defaultItem)] : items)], timeoutSec);
    return classify(raw) ?? { kind: "ok", value: raw.stdout.trim() };
  },
  async ask({ title, prompt, buttons, defaultButton, cancelButton, timeoutSec }) {
    const raw = await osa([
      "set btns to items 6 thru -1 of argv",
      "display dialog (item 2 of argv) with title (item 1 of argv) buttons btns default button (item 3 of argv) cancel button (item 4 of argv) giving up after ((item 5 of argv) as integer)",
    ], [title, prompt, defaultButton, cancelButton, String(timeoutSec), ...buttons], timeoutSec);
    const failed = classify(raw);
    if (failed) return failed;
    if (field(raw.stdout, "gave up") === "true") return { kind: "timeout" };
    return { kind: "ok", value: field(raw.stdout, "button returned") ?? "" };
  },
  async input({ title, prompt, defaultAnswer, timeoutSec }) {
    const raw = await osa([
      "display dialog (item 2 of argv) with title (item 1 of argv) default answer (item 3 of argv) buttons {\"取消\", \"好\"} default button \"好\" cancel button \"取消\" giving up after ((item 4 of argv) as integer)",
    ], [title, prompt, defaultAnswer, String(timeoutSec)], timeoutSec);
    const failed = classify(raw);
    if (failed) return failed;
    if (field(raw.stdout, "gave up") === "true") return { kind: "timeout" };
    return { kind: "ok", value: field(raw.stdout, "text returned") ?? "" };
  },
};
