/**
 * 卡片面板顶上的「下一步」（1b 验收）：一句人话 + 需要创始人拍板时的主按钮。由 explain() 的结果推出，不另立规则。
 * 用词按创始人认过的：稿子没问题 / 已经发出去了 …；屏幕上不出现 fact / sha / 版本号。
 */
export type NextAction = "approve_script" | "open_cut" | "open_cover" | "i_published";
export interface NextStep { text: string; action?: NextAction; label?: string; note?: string }

export interface NextInput {
  column: string | null; stage: string | null; status: string; missing: string[]; active: boolean;
  arolls?: unknown[];
}

const WRITTEN = new Set(["draft_ready", "reviewing", "revision"]);

export function nextStep(d: NextInput): NextStep | null {
  if (!d.active) return null;
  const col = d.stage ?? d.column;
  if (col === "写稿中") {
    if (!WRITTEN.has(d.status)) return { text: "AI 在写稿，写完等你看，暂时不用你操作" };
    return { text: "稿子写好了，你看过觉得没问题就点这里", action: "approve_script", label: "稿子没问题",
      note: (d.arolls ?? []).length ? "已经有原片了，点了就进剪辑中" : "点了进待录制，等你录" };
  }
  if (col === "待录制") return { text: "等你录原片：录好放进收件箱会自动挂上，也可以在下面「挂 A-roll」选文件" };
  if (col === "剪辑中") {
    if (d.missing.includes("成片待你审")) return { text: "成片出来了，等你看", action: "open_cut", label: "去看成片" };
    if (d.missing.includes("封面待你选")) return { text: "封面出来了，等你挑", action: "open_cover", label: "去挑封面" };
    return { text: "AI 在剪，暂时不用你操作" };
  }
  if (col === "待发布") return { text: "都通过了，可以发了；发完点这里", action: "i_published", label: "已经发出去了" };
  if (col === "已发布") return { text: "已经发出去了，暂时不用你操作" };
  return null;
}
