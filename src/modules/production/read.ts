/**
 * 读方的 explain 入口：读 production.json + 发布记录 + 启用版本，交给纯函数 `explain`。只读，零写入。
 */
import type { Content } from "../../storage/local-store.js";
import { isOntologyEnabled, readProductionDoc } from "../../storage/production-store.js";
import { firstPublishTime, readPublishRecord, type PublishRecord } from "../../storage/publish-record.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import type { PublishEvidence } from "./derive.js";
import { explain, type Explanation } from "./explain.js";

const STATE_BADGE: Record<string, string> = {
  scheduled: "已定时", overdue: "应已公开", public: "已公开", reviewing: "审核中", manual: "你标了已发布", unknown: "已投出",
};

/** 已核实回执（§6 可信来源）：AutoCrew 发布器的 publish-plan、创始人「我发了」。被驳回的不算已投出 */
export function publishEvidenceFrom(record: PublishRecord | null): PublishEvidence {
  if (!record || record.kind === "none") return { verified: false };
  const submitted = record.platforms.filter((p) => p.submitted);
  if (!submitted.length) return { verified: false };
  const badges = [...new Set(submitted.map((p) => `${p.platform} ${STATE_BADGE[p.state] ?? p.state}`))];
  const at = firstPublishTime(record);
  return { verified: true, badge: badges.join(" / "), ...(at ? { at } : {}) };
}

const PUBLISH_READ: ReadonlySet<string> = new Set(["approved", "editing", "cover_pending", "publish_ready", "publishing", "published"]);

/** 发布记录只对认过稿之后的视频稿 / 待发布的图文有意义；读不到当「没有已核实回执」 */
export async function publishEvidenceOf(content: Content, dataDir: string, record?: PublishRecord | null): Promise<PublishEvidence> {
  if (record !== undefined) return publishEvidenceFrom(record);
  if (!PUBLISH_READ.has(content.status) && !content.manualPublications?.length) return { verified: false };
  const r = await readPublishRecord(content.id, content.manualPublications, dataDir).catch(() => null);
  return publishEvidenceFrom(r);
}

export interface ExplainContext { enabled: boolean }

export async function explainContext(dataDir: string): Promise<ExplainContext> {
  return { enabled: await isOntologyEnabled(dataDir).catch(() => false) };
}

/** 读方统一入口：production.json 坏了不挡读，按「没有事实」算并把原因带出来 */
export async function explainContent(content: Content, dataDir: string, ctx?: ExplainContext, record?: PublishRecord | null): Promise<Explanation & { error?: string }> {
  const { enabled } = ctx ?? (await explainContext(dataDir));
  let error: string | undefined;
  const doc = isVideoPlatform(content.platform)
    ? await readProductionDoc(content.id, dataDir).catch((e: unknown) => { error = e instanceof Error ? e.message : String(e); return null; })
    : null;
  const publish = await publishEvidenceOf(content, dataDir, record);
  return { ...explain({ content, doc, enabled, publish }), ...(error ? { error } : {}) };
}

/** 一批稿件的 explain（读方批量用：看板以外的晨报、desk）。单条读坏不挡别条，按「没有事实」算 */
export async function explainAll(contents: Content[], dataDir: string): Promise<Map<string, Explanation>> {
  const ctx = await explainContext(dataDir);
  const out = new Map<string, Explanation>();
  for (const c of contents) out.set(c.id, await explainContent(c, dataDir, ctx));
  return out;
}
