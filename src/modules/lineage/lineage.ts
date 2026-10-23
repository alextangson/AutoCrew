/**
 * 派生关系（全媒体 spec §8 Phase 1 #2，Codex 会审 #7）：英文版、公众号文章都是从一条审过的中文成片派生的兄弟稿。
 *
 * - `derivedFrom` 落盘（不像 rewrite 的来源标注那样在入库前丢掉）；
 * - `deriveSibling` 幂等：同一源 + 同一种派生，第二次调用拿回已有那条，不建第二条；两边互挂 siblings；
 * - `staleReason` / `isStale`：源稿当前审过的成片身份 ≠ 派生时记下的 → 过期，看板标红。
 *
 * 成片身份（approvedCutIdentity）取现有最强的那个：
 * - 按本体走的视频稿：当前有效的「成片批准」所绑成片文件的 sha256（validCutApproval：撤批、打回、改稿后自动失效）——
 *   字节级身份，与发布出口 registeredPackage 认的是同一份；
 * - 旧流程稿：`videoDone.renderedRevision`（只有渲染代次，没有文件指纹；重开剪辑会清掉 videoDone）。
 * 两种身份带前缀区分，旧稿后来启用本体时身份变了也会如实报过期，不会误判成同一版。
 */
import { getContent, listContents, saveContent, updateContentWith, type Content, type DerivationKind } from "../../storage/local-store.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { validCutApproval } from "../production/derive.js";
import { ontologyApplies } from "../production/publish-gate.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { checkArtifactApproval, shortHash } from "./artifact-approval.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import { loadProfile } from "../profile/creator-profile.js";
import { lineRefusal } from "../profile/platform-lines.js";

export const DERIVATION_KINDS: readonly DerivationKind[] = ["en_edition", "wechat_article"];

/** 每种派生落在哪个平台、标题怎么标 */
const TARGET: Record<DerivationKind, { platform: string; suffix: string }> = {
  en_edition: { platform: "youtube", suffix: "（英文版）" },
  wechat_article: { platform: "wechat_mp", suffix: "（公众号）" },
};

export type DeriveResult =
  | { ok: true; content: Content; created: boolean }
  | { ok: false; code: string; error: string };

/** 源稿当前审过的成片身份；没有审过的成片 = null */
export async function approvedCutIdentity(content: Content, dataDir: string): Promise<string | null> {
  if (await ontologyApplies(content, dataDir)) {
    const approval = validCutApproval(await readProductionDocOrEmpty(content.id, dataDir), content.body);
    return approval?.sha256 ? `sha256:${approval.sha256}` : null;
  }
  return content.videoDone ? `legacy-rev:${content.videoDone.renderedRevision}` : null;
}

/** 参数可能是字符串化的值（中转端点的老毛病）：去引号、去空白后再认 */
export function parseDerivationKind(raw: unknown): DerivationKind | null {
  const v = typeof raw === "string" ? raw.trim().replace(/^"+|"+$/g, "") : "";
  return (DERIVATION_KINDS as readonly string[]).includes(v) ? (v as DerivationKind) : null;
}

const inFlight = new Map<string, Promise<DeriveResult>>();

/** 同进程并发两次（双击）只建一条：第二次等第一次的结果 */
export function deriveSibling(sourceId: string, kindRaw: unknown, dataDir: string): Promise<DeriveResult> {
  const kind = parseDerivationKind(kindRaw);
  if (!kind) return Promise.resolve({ ok: false, code: "bad_kind", error: `派生类型只能是 ${DERIVATION_KINDS.join(" / ")}，收到 ${String(kindRaw)}` });
  const key = `${dataDir}\0${sourceId}\0${kind}`;
  const running = inFlight.get(key);
  if (running) return running;
  const job = deriveOnce(sourceId, kind, dataDir).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

async function deriveOnce(sourceId: string, kind: DerivationKind, dataDir: string): Promise<DeriveResult> {
  const source = await getContent(sourceId, dataDir).catch(missingAsNull);
  if (!source) return { ok: false, code: "source_missing", error: `源稿 ${sourceId} 不存在` };
  if (source.derivedFrom) return { ok: false, code: "source_is_derived", error: "这条本身是派生稿，只能从原始中文视频派生" };
  const existing = (await listContents(dataDir)).find((c) => c.derivedFrom?.contentId === sourceId && c.derivedFrom.kind === kind && !c.deletedAt);
  if (existing) return { ok: true, content: await linkBothWays(source.id, existing.id, dataDir), created: false };
  // 线没开（没勾对应平台）就不派生；已派生的上面已原样返回，改勾选不影响旧稿
  const refusal = lineRefusal(await loadProfile(dataDir), kind);
  if (refusal) return { ok: false, code: "line_not_enabled", error: refusal };
  if (!isVideoPlatform(source.platform)) return { ok: false, code: "source_not_video", error: "只能从视频稿派生（源稿不是视频平台）" };
  const cut = await approvedCutIdentity(source, dataDir);
  if (!cut) return { ok: false, code: "no_approved_cut", error: "源视频还没有审过的成片：先在剪辑台把成片审过，再派生" };
  const target = TARGET[kind];
  const created = await saveContent({
    title: `${source.title}${target.suffix}`, body: "", platform: target.platform, status: "drafting", tags: [...(source.tags ?? [])],
    siblings: [source.id], derivedFrom: { contentId: source.id, kind, sourceCutHash: cut, at: new Date().toISOString() },
  }, dataDir);
  return { ok: true, content: await linkBothWays(source.id, created.id, dataDir), created: true };
}

/** 源 ↔ 派生互挂 siblings（已挂的不重复）；返回派生稿的最新样子 */
async function linkBothWays(sourceId: string, derivedId: string, dataDir: string): Promise<Content> {
  const add = (list: string[] | undefined, id: string) => (list ?? []).includes(id) ? list ?? [] : [...(list ?? []), id];
  await updateContentWith(sourceId, (c) => (c.siblings ?? []).includes(derivedId) ? {} : { siblings: add(c.siblings, derivedId) }, dataDir);
  const derived = await updateContentWith(derivedId, (c) => (c.siblings ?? []).includes(sourceId) ? {} : { siblings: add(c.siblings, sourceId) }, dataDir);
  if (!derived) throw new Error(`派生稿 ${derivedId} 读不到了`);
  return derived;
}

/** 过期原因（人话）；不是派生稿或没过期 = null */
export async function staleReason(item: Pick<Content, "derivedFrom">, dataDir: string): Promise<string | null> {
  const from = item.derivedFrom;
  if (!from) return null;
  const source = await getContent(from.contentId, dataDir).catch(missingAsNull);
  if (!source || source.deletedAt) return `源视频（${from.contentId}）不在了：这条派生稿没有依据，先确认要不要保留`;
  const current = await approvedCutIdentity(source, dataDir);
  const check = checkArtifactApproval({ artifact: "源视频成片", hash: from.sourceCutHash, approvedAt: from.at }, current);
  if (check.ok) return null;
  return check.code === "artifact_missing"
    ? "源视频的成片现在没有有效的审片通过（撤批或重开了剪辑）：这条是按旧成片做的，等新成片审过后要重做"
    : `源视频换了一版成片（派生时 ${shortHash(from.sourceCutHash)}，现在 ${shortHash(current ?? "")}）：这条是按旧成片做的，要按新成片重做`;
}

export async function isStale(item: Pick<Content, "derivedFrom">, dataDir: string): Promise<boolean> {
  return (await staleReason(item, dataDir)) !== null;
}
