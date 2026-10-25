/**
 * 内容管线读模型：看板数据 + 主题分组 + 每主题去向计划 + 公众号回执。**只读，零写入**（没落盘的计划按当前勾选算默认）。
 */
import { boardData, type BoardData } from "../../desktop/board-data.js";
import { listContents, type Content } from "../../storage/local-store.js";
import { loadProfile } from "../profile/creator-profile.js";
import { readPublishState, type ArticlePublishState } from "../wechat-article/publish-state.js";
import { groupThemes, type ThemeCard } from "./group.js";
import { isThemeRoot, readPlan, type DestinationPlan } from "./plan.js";

export interface PipelineData extends BoardData { themes: ThemeCard[]; planErrors: Array<{ id: string; error: string }> }

export async function themesOf(board: BoardData, contents: Content[], dataDir: string, now = new Date()): Promise<{ themes: ThemeCard[]; planErrors: PipelineData["planErrors"] }> {
  const profile = await loadProfile(dataDir);
  const onBoard = new Set(board.items.map((i) => i.id));
  const plans = new Map<string, { plan: DestinationPlan; persisted: boolean; legacy?: boolean }>();
  const planErrors: PipelineData["planErrors"] = [];
  const articles = new Map<string, ArticlePublishState | Error>();
  for (const c of contents) {
    if (!onBoard.has(c.id)) continue;
    if (isThemeRoot(c)) {
      // 计划读坏了：照实报出来，这张卡按「没定去向」显示，不冒充默认
      try { plans.set(c.id, await readPlan(c, dataDir, profile)); }
      catch (e) { planErrors.push({ id: c.id, error: e instanceof Error ? e.message : String(e) }); }
    }
    if (c.platform === "wechat_mp") {
      articles.set(c.id, await readPublishState(c.id, dataDir).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
    }
  }
  const themes = groupThemes({ items: board.items, contents, plans, articles, now });
  for (const err of planErrors) {
    const t = themes.find((x) => x.id === err.id);
    if (t) t.exceptions.unshift(`去向计划读不出来：${err.error}`);
  }
  return { themes, planErrors };
}

export async function pipelineData(dataDir: string): Promise<PipelineData> {
  const [board, contents] = await Promise.all([boardData(dataDir), listContents(dataDir)]);
  return { ...board, ...(await themesOf(board, contents, dataDir)) };
}

/** 一条稿属于哪个主题（「要你做的」按主题分组显示用）：父 = derivedFrom 指向的稿（父不在或本身是派生 = 自己） */
export function themeIndex(contents: Array<Pick<Content, "id" | "title" | "derivedFrom">>): Map<string, { id: string; title: string }> {
  const byId = new Map(contents.map((c) => [c.id, c]));
  const out = new Map<string, { id: string; title: string }>();
  for (const c of contents) {
    const parent = c.derivedFrom ? byId.get(c.derivedFrom.contentId) : undefined;
    const root = parent && !parent.derivedFrom ? parent : c;
    out.set(c.id, { id: root.id, title: root.title });
  }
  return out;
}
