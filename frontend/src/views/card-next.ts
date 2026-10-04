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

/**
 * 稿件页标题下那一行（1b 验收）：写稿段已经有原片的稿也要说清；按钮在稿件页顶上叫「稿子没问题，进入制作」。
 * 没什么可说的（普通在写的稿）→ null。
 */
export function bannerText(d: NextInput & { badges?: string[] }): string | null {
  const col = d.stage ?? d.column;
  if (!col) return null;
  if (col === "写稿中") {
    const hasAroll = (d.arolls ?? []).length > 0 || (d.badges ?? []).some((b) => b.startsWith("已有原片"));
    if (WRITTEN.has(d.status)) return hasAroll ? "已经有原片了，稿子没问题就点上面「稿子没问题，进入制作」" : "稿子没问题就点上面「稿子没问题，进入制作」，之后进待录制等你录";
    return hasAroll ? "AI 还在写稿；原片已经在了，写完你看过就能进制作" : null;
  }
  return nextStep({ ...d, active: true })?.text ?? null;
}

export function nextStep(d: NextInput): NextStep | null {
  if (!d.active) return null;
  const col = d.stage ?? d.column;
  if (col === "写稿中") {
    if (!WRITTEN.has(d.status)) return { text: "AI 在写稿，写完等你看，暂时不用你操作" };
    return { text: "稿子写好了，你看过觉得没问题就点这里", action: "approve_script", label: "稿子没问题",
      note: (d.arolls ?? []).length ? "已经有原片了，点了就进剪辑中" : "点了进待录制，等你录" };
  }
  if (col === "待录制") return { text: "等你录原片：录好放进收件箱会自动挂上，也可以在下面「挂原片」选文件" };
  if (col === "剪辑中") {
    // 你点过「还要改…」：说你的那句话、等 AI 交新版（verifier 2a P1）
    const ask = d.missing.find((m) => m.startsWith("你说"));
    if (ask) return { text: `${ask}；等 AI 交新版，暂时不用你操作` };
    if (d.missing.includes("成片待你审")) return { text: "成片出来了，等你看", action: "open_cut", label: "去看成片" };
    if (d.missing.includes("封面待你选")) return { text: "封面出来了，等你挑", action: "open_cover", label: "去挑封面" };
    return { text: "AI 在剪，暂时不用你操作" };
  }
  if (col === "待发布") return { text: "都通过了，可以发了；发完点这里", action: "i_published", label: "已经发出去了" };
  if (col === "已发布") return { text: "已经发出去了，暂时不用你操作" };
  return null;
}

/** 稿件页进度区的 key：状态或存盘时刻变了就重挂，重读拿新的稿件代次（Codex 审 P2） */
export const progressKey = (status: string, updatedAt: string): string => `${status}@${updatedAt}`;
