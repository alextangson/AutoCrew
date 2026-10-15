/**
 * 写稿交给谁（spec 2026-10-15 §B）的前端部分：交出去之后怎么说、剪贴板、失败怎么办、卡上「等它接手 / 在写」那句。
 * 打开哪个 App、指令是什么由服务端定；这里只负责把指令放进剪贴板和说清楚。
 */
import { useEffect, useState } from "react";
import { confirmDialog, toast } from "../ui";
import type { ApiResult, Delivery } from "./board-api";
import { loadConnect, type HostId } from "./onboarding/connect-api";

export const WRITER_LABEL: Record<HostId, string> = { claude: "Claude Code", codex: "Codex", workbuddy: "WorkBuddy" };
export const SETTINGS_HREF = "#/settings?tab=integrations";

/** 写稿阶段（与服务端 writing-handoff 的 WRITING 同一组）：顶栏是「交给 X 写」；其余阶段「交给 X 看」 */
export const WRITING_STATUSES: ReadonlySet<string> = new Set(["topic_saved", "drafting", "draft_ready", "reviewing", "revision", "needs_evidence"]);


export interface Writers { writers: HostId[]; defaultHost: HostId | null; error?: string }

/** 默认写稿 AI：存下的默认还接着就是它，否则第一个接上的（与服务端 pickWriter 同一规则；最终以服务端为准） */
export function effectiveWriter(writers: HostId[], saved: HostId | null | undefined): HostId | null {
  return saved && writers.includes(saved) ? saved : writers[0] ?? null;
}

export function useWriters(): Writers | null {
  const [w, setW] = useState<Writers | null>(null);
  useEffect(() => {
    let live = true;
    void loadConnect().then((r) => {
      if (!live) return;
      if (!r.ok) return setW({ writers: [], defaultHost: null, error: r.error });
      const writers = r.data.writers ?? [];
      setW({ writers, defaultHost: effectiveWriter(writers, r.data.writingHost) });
    });
    return () => { live = false; };
  }, []);
  return w;
}

/** 交出去之后那一句（剪贴板已经写好 / 没写成两种） */
export function deliveryText(d: Delivery, mode: "write" | "look", copied: boolean): string {
  const verb = mode === "write" ? "开始写" : "看这篇";
  if (!d.paste) return `已交给 ${d.label}：新会话里填好了指令，按发送${verb}`;
  if (!copied) return `${d.label}${d.opened ? " 已打开" : ""}，但指令没能写进剪贴板`;
  if (d.open_error) return `${d.label} 没打开（${d.open_error}）。指令已复制，去 ${d.label} 里粘贴发送`;
  if (d.opened) return `${d.label} 已打开，粘贴发送`;
  return `指令已复制，粘到 ${d.label} 里发出去`;
}

/** 放剪贴板 + 说一句；剪贴板写不进去就把指令原文摆出来让人手动复制 */
export async function announce(d: Delivery, mode: "write" | "look", prefix = ""): Promise<void> {
  let copied = !d.paste;
  if (d.paste) {
    try { await navigator.clipboard.writeText(d.prompt); copied = true; } catch { copied = false; }
  }
  const text = prefix + deliveryText(d, mode, copied);
  if (copied) return toast(text);
  await confirmDialog({ title: "没能写进剪贴板", body: `${text}。请手动复制下面这句，发给 ${d.label}：\n\n${d.prompt}`, confirmLabel: "知道了" });
}

type Failure = { error: string; body?: Record<string, unknown> };

/** 交不出去：没接 AI → 先接一个；默认的断开了 → 换一个 / 去设置；认领中 → 照实说。retry(host) 换一个 AI 再交 */
export async function explainFailure(f: Failure, retry: (host: HostId) => Promise<void>): Promise<void> {
  const code = f.body?.code;
  if (code === "no_writer") {
    const go = await confirmDialog({ title: "先接一个 AI", body: "写稿要一个接上了 AutoCrew 的 AI（Claude Code、Codex 或 WorkBuddy）。去设置里接上就能开工，这次什么都没建。", confirmLabel: "去设置" });
    if (go) window.location.hash = SETTINGS_HREF;
    return;
  }
  if (code === "default_gone") {
    const alt = ((f.body?.alternatives as Array<{ host: HostId; label: string }> | undefined) ?? [])[0];
    const yes = await confirmDialog({ title: f.error, body: alt ? `这次换 ${alt.label} 写？也可以去设置里重新接上。` : "去设置里重新接上，或换一个 AI 接上。这次什么都没建。", confirmLabel: alt ? `换 ${alt.label}` : "去设置" });
    if (yes && alt) await retry(alt.host);
    else if (yes) window.location.hash = SETTINGS_HREF;
    return;
  }
  toast(f.error);
}

export async function settle(r: ApiResult<Delivery>, mode: "write" | "look", retry: (host: HostId) => Promise<void>, prefix = ""): Promise<void> {
  if (r.ok) return announce(r.data, mode, prefix);
  return explainFailure(r, retry);
}

export { handoffLine, PICKUP_STALE_MS, type HandoffView } from "./handoff-line";
