/**
 * 读方的 explain 入口：读 production.json + 发布记录 + 启用版本，交给纯函数 `explain`。只读，零写入。
 */
import type { Content } from "../../storage/local-store.js";
import { DERIVE_VERSION, readEnabledMarker, readProductionDoc } from "../../storage/production-store.js";
import { firstPublishTime, readPublishRecord, type PublishRecord } from "../../storage/publish-record.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import type { PublishEvidence } from "./derive.js";
import { explain, type Explanation } from "./explain.js";

const STATE_BADGE: Record<string, string> = {
  scheduled: "已定时", overdue: "应已公开", public: "已公开", reviewing: "审核中", manual: "你标了已发布", unknown: "已投出",
};

/** 已核实回执（§6 可信来源）：AutoCrew 发布器的 publish-plan、创始人「我发了」。被驳回的不算已投出 */
export function publishEvidenceFrom(record: PublishRecord | null, since?: string): PublishEvidence {
  if (!record || record.kind === "none") return { verified: false };
  // 被驳回的不算已投出（parsePlatformEntry 给 rejected 也标 submitted，Codex 审 P1）；
  // 重开文稿之后，本轮开始前的发布证据属于历史轮（P2）
  const inRound = (t: string | null) => !since || (t !== null && Date.parse(t) >= Date.parse(since));
  const submitted = record.platforms.filter((p) => p.submitted && p.state !== "rejected" && inRound(p.time));
  if (!submitted.length) return { verified: false };
  const badges = [...new Set(submitted.map((p) => `${p.platform} ${STATE_BADGE[p.state] ?? p.state}`))];
  const at = firstPublishTime(record);
  return { verified: true, badge: badges.join(" / "), ...(at ? { at } : {}) };
}

const PUBLISH_READ: ReadonlySet<string> = new Set(["approved", "editing", "cover_pending", "publish_ready", "publishing", "published"]);

/** 发布记录只对认过稿之后的视频稿 / 待发布的图文有意义；读不到当「没有已核实回执」 */
export async function publishEvidenceOf(content: Content, dataDir: string, record?: PublishRecord | null, since?: string): Promise<PublishEvidence> {
  if (record !== undefined) return publishEvidenceFrom(record, since);
  if (!PUBLISH_READ.has(content.status) && !content.manualPublications?.length) return { verified: false };
  const r = await readPublishRecord(content.id, content.manualPublications, dataDir).catch(() => null);
  return publishEvidenceFrom(r, since);
}

export interface ExplainContext { enabled: boolean; excluded: ReadonlySet<string> }

export async function explainContext(dataDir: string): Promise<ExplainContext> {
  const m = await readEnabledMarker(dataDir).catch(() => null);
  return { enabled: m?.version === DERIVE_VERSION, excluded: new Set(m?.excluded ?? []) };
}

/** 读方统一入口：production.json 坏了不挡读，按「没有事实」算并把原因带出来 */
export async function explainContent(content: Content, dataDir: string, ctx?: ExplainContext, record?: PublishRecord | null): Promise<Explanation & { error?: string }> {
  const c = ctx ?? (await explainContext(dataDir));
  const excluded = c.enabled && c.excluded.has(content.id);
  let error: string | undefined;
  const doc = isVideoPlatform(content.platform)
    ? await readProductionDoc(content.id, dataDir).catch((e: unknown) => { error = e instanceof Error ? e.message : String(e); return null; })
    : null;
  const active = c.enabled && !excluded;
  // 按本体走的稿只认本轮回执（§6）；影子 / 旧行为照旧读发布记录给旧列
  const publish = active && isVideoPlatform(content.platform) ? { verified: false } : await publishEvidenceOf(content, dataDir, record, doc?.round_started_at);
  const exp = explain({ content, doc, enabled: active, publish });
  // 启用时被排除的稿：照旧行为，卡片上标出来（从不静默跳过）
  const flagged = excluded ? { ...exp, badges: [...exp.badges, "未纳入本体（启用时对账失败，已排除）"] } : exp;
  return { ...flagged, ...(error ? { error } : {}) };
}

/** 一批稿件的 explain（读方批量用：看板以外的晨报、desk）。单条读坏不挡别条，按「没有事实」算 */
export async function explainAll(contents: Content[], dataDir: string): Promise<Map<string, Explanation>> {
  const ctx = await explainContext(dataDir);
  const out = new Map<string, Explanation>();
  for (const c of contents) out.set(c.id, await explainContent(c, dataDir, ctx));
  return out;
}
