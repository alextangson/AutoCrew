/**
 * IPC 结果 → 引擎事件映射（纯函数，可测）。
 * 只映射「值得进工作日志」的动作；label 是渲染的唯一展示字段，必须人话。
 * 工具执行的开工线（编剧正在写稿…）不在此——由 main.ts 的 chat 进度桥直发。
 */
import type { EngineEvent } from "./event-hub.js";
import type { IpcChannel } from "./channels.js";

export interface EventMapInput {
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
}

type Mapper = (input: EventMapInput) => Omit<EngineEvent, "ts"> | null;

const STATUS_LABELS: Record<string, string> = {
  topic_saved: "选题已存", drafting: "写作中", draft_ready: "草稿就绪", reviewing: "待审",
  revision: "修订中", approved: "已过审", cover_pending: "待封面", publish_ready: "待发布",
  publishing: "发布中", published: "已发布", archived: "已归档",
};

const VERDICT_LABELS: Record<string, string> = {
  adopted: "采纳", light_edit: "轻改采纳", rewritten: "重写",
};

function contentTitle(result: Record<string, unknown>): string {
  const c = result.content as { title?: string } | undefined;
  return c?.title ? `《${c.title}》` : "稿件";
}

export const CHANNEL_EVENT_MAP: Partial<Record<IpcChannel, Mapper>> = {
  "persona:save": ({ result }) => {
    if (result.ok !== true) return null;
    return { role: "analyst", kind: "persona", label: "受众画像已确认——审稿标准即刻生效" };
  },

  "content:transition": ({ payload, result }) => {
    if (result.ok !== true) return null;
    const target = String(payload.target_status ?? "");
    return {
      role: "system",
      kind: "transition",
      label: `${contentTitle(result)} → ${STATUS_LABELS[target] ?? target}`,
      contentId: (payload.id as string) || undefined,
    };
  },

  "content:adoption": ({ payload, result }) => {
    if (result.ok !== true) return null;
    const verdict = VERDICT_LABELS[String(payload.verdict)] ?? String(payload.verdict);
    const stats = result.stats as { rate: number | null } | undefined;
    const rate = stats && stats.rate !== null ? `（采纳率 ${Math.round(stats.rate * 100)}%）` : "";
    return {
      role: "system",
      kind: "adoption",
      label: `你裁决了${contentTitle(result)}：${verdict}${rate}`,
      contentId: (payload.id as string) || undefined,
    };
  },

  // 只在真的蒸馏出新规则时记日志——普通保存不刷屏
  "content:update": ({ result }) => {
    const learned = result.styleLearned as { newRules?: unknown[] } | undefined;
    if (result.ok !== true || !learned?.newRules?.length) return null;
    return { role: "writer", kind: "style_learned", label: `编剧从你的修改里学到 ${learned.newRules.length} 条风格规则` };
  },

  "publish:wechat_draft": ({ payload, result }) => {
    const violations = result.violations as string[] | undefined;
    if (result.ok !== true) {
      if (violations?.length) {
        return {
          role: "review",
          kind: "publish_blocked",
          label: `审核员阻断推送：命中「${violations.join("、")}」`,
          contentId: (payload.content_id as string) || undefined,
        };
      }
      return null; // 其他失败走 toast，不进日志
    }
    const n = typeof result.imageCount === "number" ? result.imageCount : 0;
    return {
      role: "publisher",
      kind: "publish_receipt",
      label: `发布员已推公众号草稿箱（配图 ${n} 张）`,
      contentId: (payload.content_id as string) || undefined,
    };
  },

  "content:delete": ({ payload, result }) => {
    if (result.ok !== true) return null;
    return { role: "system", kind: "trash", label: `你把${contentTitle(result)}移入了回收站`, contentId: (payload.id as string) || undefined };
  },

  "content:restore": ({ payload, result }) => {
    if (result.ok !== true) return null;
    return { role: "system", kind: "trash", label: `你从回收站恢复了${contentTitle(result)}`, contentId: (payload.id as string) || undefined };
  },

  "topic:delete": ({ result }) => {
    if (result.ok !== true) return null;
    const t = result.topic as { title?: string } | undefined;
    return { role: "system", kind: "trash", label: `你把选题「${t?.title ?? ""}」移入了回收站` };
  },

  "topic:restore": ({ result }) => {
    if (result.ok !== true) return null;
    const t = result.topic as { title?: string } | undefined;
    return { role: "system", kind: "trash", label: `你从回收站恢复了选题「${t?.title ?? ""}」` };
  },

  "radar:refresh": ({ result }) => {
    if (result.ok !== true) return null;
    const d = result.data as { topics?: unknown[] } | undefined;
    const n = Array.isArray(d?.topics) ? d.topics.length : undefined;
    return { role: "scout", kind: "radar", label: n !== undefined ? `侦察员扫榜完成：${n} 条候选` : "侦察员扫榜完成" };
  },
};
