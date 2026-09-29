/**
 * AIHOT 热点榜 — aihot.news 公开只读 API(免 key),把多家来源报道的同一件事聚成事件,
 * 按「有几家独立来源在说」排序。标题已是中文。
 * heat = sourceCount(独立来源数):同一家发十篇只算一次,是真实的「大家都在说」信号。
 * 清单型源:榜单本身就是过滤器,不吃检索词。
 * 失败直接抛错(不像 HN 那样吞成 []):雷达把抛错记进 failedSources,源坏了看得见。
 * 使用边界:aihot.news 数据受其《公开使用规则》约束——个人/组织内部研究免费,
 * 对外商业产品或转发数据需书面授权。所以它不进内置默认源,只由用户自己加。
 */
import type { SourceItem } from "./types.js";

const HOT_TOPICS_URL = "https://aihot.news/api/v1/hot-topics";
const TIMEOUT_MS = 12_000;

interface HotTopic {
  title?: string;
  links?: { aihot?: string; original?: string };
  sourceCount?: number;
  participantCount?: number;
  sourceNames?: string[];
}

export interface AihotDeps {
  fetchImpl?: typeof fetch;
}

export async function fetchAihotHot(limit = 10, deps: AihotDeps = {}): Promise<SourceItem[]> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const res = await fetchFn(HOT_TOPICS_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "AutoCrew/1.0 (personal topic radar)" },
  });
  if (!res.ok) throw new Error(`AIHOT 热点榜 HTTP ${res.status}`);
  const data = (await res.json()) as { items?: HotTopic[] };
  const items = Array.isArray(data?.items) ? data.items : [];

  const out = items
    .map((t): SourceItem | null => {
      const title = (t.title ?? "").trim();
      // 原文链接优先:后续调研要读一手来源;缺了才退到 AIHOT 条目页
      const url = t.links?.original || t.links?.aihot || "";
      if (!title || !url) return null;
      const sources = typeof t.sourceCount === "number" ? t.sourceCount : undefined;
      const names = (t.sourceNames ?? []).slice(0, 3).join("、");
      const summary = [
        sources !== undefined ? `${sources} 家来源在报道` : "",
        typeof t.participantCount === "number" ? `${t.participantCount} 人参与讨论` : "",
        names ? `来源含 ${names}` : "",
      ].filter(Boolean).join(" · ");
      return {
        title,
        url,
        source: "aihot_hot",
        ...(sources !== undefined ? { heat: sources } : {}),
        ...(summary ? { summary } : {}),
      };
    })
    .filter((it): it is SourceItem => it !== null)
    .slice(0, limit);
  // 200 但一条都没有 = 接口形状变了或服务降级,按失败报,不当成「今天没热点」
  if (out.length === 0) throw new Error("AIHOT 热点榜解析 0 条");
  return out;
}
