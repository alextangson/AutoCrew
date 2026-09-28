/** 「＋新想法」：顶栏与空看板的选题列共用同一个入口 */
import { invoke } from "./transport";
import { openDialog, toast } from "./ui";

export async function newIdea(): Promise<boolean> {
  const v = await openDialog({
    title: "新想法",
    body: "写一句标题,或直接丢一段碎片想法——AI 会帮你提炼成选题,原文留作材料。",
    fields: [
      { key: "title", label: "选题", placeholder: "一句话说清写什么,如:Claude Code 的 10 个隐藏用法;或直接粘一段碎片想法", required: true, multiline: true },
      { key: "reason", label: "为什么值得写", placeholder: "如:后台好多人在问 / 热点窗口期" },
    ],
    confirmLabel: "放进选题",
  });
  if (!v) return false;
  // 长输入要等一次 LLM 提炼(几秒),中间不能全无反馈;短输入这条会被结果 toast 秒替换
  toast("正在整理这条想法…");
  const r = await invoke("topic:create", { title: v.title.trim(), ...(v.reason.trim() ? { reason: v.reason.trim() } : {}) });
  if (!r.ok) {
    toast((r as { error?: string }).error ?? "入库失败");
    return false;
  }
  // 提炼过的要让用户看见 AI 把标题改成了什么;失败的要说清原文已保存、需自己改标题
  const d = r as { distilled?: boolean; warning?: string; topic?: { title?: string } };
  toast(d.distilled ? `已提炼为「${d.topic?.title ?? ""}」放进选题` : d.warning ?? "已放进看板的选题列");
  return true;
}
