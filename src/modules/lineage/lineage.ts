/**
 * 派生关系（全媒体 spec §8 Phase 1 #2，Codex 会审 #7）：英文版、公众号文章都是从一条审过的中文成片派生的兄弟稿。
 *
 * - `derivedFrom` 落盘（不像 rewrite 的来源标注那样在入库前丢掉）；
 * - `deriveSibling` 幂等：同一源 + 同一种派生，第二次调用拿回已有那条，不建第二条；两边互挂 siblings；
 *   先按源稿 siblings 逐条严格读（读不出直接报错，不当成「没有」再建一条），再扫一遍兜底没挂上的；
 *   跨进程靠资料库写入占用（assertDataDirWritable：只有持有 .autocrew-writer 的服务能写），进程内靠按规范路径的锁；
 * - `staleReason` / `isStale`：源稿当前审过的成片身份（cut-identity.ts）≠ 派生时记下的 → 过期。
 */
import path from "node:path";
import { getContent, getContentStrict, listContents, saveContent, updateContentWith, type Content, type DerivationKind } from "../../storage/local-store.js";
import { assertDataDirWritable } from "../../storage/storage-roots.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { checkArtifactApproval, shortHash } from "./artifact-approval.js";
import { approvedCutIdentity } from "./cut-identity.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import { STILL_SETTLING } from "../production/hash-cache.js";
import { loadProfile } from "../profile/creator-profile.js";
import { enKitPlatforms, lineRefusal } from "../profile/platform-lines.js";

export { approvedCutIdentity };

export const DERIVATION_KINDS: readonly DerivationKind[] = ["en_edition", "wechat_article"];

const SUFFIX: Record<DerivationKind, string> = { en_edition: "（英文版）", wechat_article: "（公众号）" };

/** 派生稿落在哪个平台：公众号文章 = wechat_mp；英文版 = 用户勾的第一个英文平台（只勾 X 就是 x） */
function targetPlatform(kind: DerivationKind, profile: { platforms?: unknown } | null): string | null {
  return kind === "wechat_article" ? "wechat_mp" : enKitPlatforms(profile)[0] ?? null;
}

export type DeriveResult =
  | { ok: true; content: Content; created: boolean }
  | { ok: false; code: string; error: string };

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
  const key = `${path.resolve(dataDir)}\0${sourceId}\0${kind}`;
  const running = inFlight.get(key);
  if (running) return running;
  const job = deriveOnce(sourceId, kind, dataDir).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

async function deriveOnce(sourceId: string, kind: DerivationKind, dataDir: string): Promise<DeriveResult> {
  const source = await getContent(sourceId, dataDir).catch(missingAsNull);
  if (!source) return { ok: false, code: "source_missing", error: `源稿 ${sourceId} 不存在` };
  if (source.deletedAt) return { ok: false, code: "source_deleted", error: "源稿在回收站里：先恢复它，再派生" };
  if (source.derivedFrom) return { ok: false, code: "source_is_derived", error: "这条本身是派生稿，只能从原始中文视频派生" };
  const found = await existingDerived(source, kind, dataDir);
  if ("error" in found) return { ok: false, code: "sibling_unreadable", error: found.error };
  if (found.content) return { ok: true, content: await linkBothWays(source.id, found.content.id, dataDir), created: false };
  return createDerived(source, kind, dataDir);
}

/** 已有的同类派生稿：先按源稿 siblings 严格读（读不出 = 报错），再全量扫兜底（建好还没挂上的） */
async function existingDerived(source: Content, kind: DerivationKind, dataDir: string): Promise<{ content: Content | null } | { error: string }> {
  const match = (c: Content | null) => c && c.derivedFrom?.contentId === source.id && c.derivedFrom.kind === kind && !c.deletedAt;
  for (const id of source.siblings ?? []) {
    let sib: Content | null;
    try { sib = await getContentStrict(id, dataDir).catch(missingAsNull); }
    catch (e) { return { error: `兄弟稿 ${id} 读不出来（${e instanceof Error ? e.message : String(e)}）：先修好它，不然可能重复派生` }; }
    if (match(sib)) return { content: sib };
  }
  return { content: (await listContents(dataDir)).find((c) => match(c)) ?? null };
}

async function createDerived(source: Content, kind: DerivationKind, dataDir: string): Promise<DeriveResult> {
  // 线没开（没勾对应平台）就不派生；已派生的上面已原样返回，改勾选不影响旧稿
  const profile = await loadProfile(dataDir);
  const refusal = lineRefusal(profile, kind);
  if (refusal) return { ok: false, code: "line_not_enabled", error: refusal };
  if (!isVideoPlatform(source.platform)) return { ok: false, code: "source_not_video", error: "只能从视频稿派生（源稿不是视频平台）" };
  const cut = await approvedCutIdentity(source, dataDir, { fresh: true });
  if (cut.id === null) return { ok: false, code: "no_approved_cut", error: `${cut.reason}：先在剪辑台把成片审过，再派生` };
  try { assertDataDirWritable(dataDir); }
  catch (e) { return { ok: false, code: "library_not_writable", error: e instanceof Error ? e.message : String(e) }; }
  const created = await saveContent({
    // 跟源视频同一个选题：写作包按选题领（调研简报、立意都是源视频那份）
    title: `${source.title}${SUFFIX[kind]}`, body: "", platform: targetPlatform(kind, profile)!, status: "drafting", tags: [...(source.tags ?? [])],
    ...(source.topicId ? { topicId: source.topicId } : {}),
    siblings: [source.id], derivedFrom: { contentId: source.id, kind, sourceCutHash: cut.id, at: new Date().toISOString() },
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

/**
 * 过期原因（人话）；不是派生稿或没过期 = null。
 * `fresh: true`（发布前）现算源成片哈希；默认（看板）走元数据缓存。
 */
export async function staleReason(item: Pick<Content, "derivedFrom">, dataDir: string, opts: { fresh?: boolean } = {}): Promise<string | null> {
  const from = item.derivedFrom;
  if (!from) return null;
  const source = await getContent(from.contentId, dataDir).catch(missingAsNull);
  if (!source || source.deletedAt) return `源视频（${from.contentId}）不在了：这条派生稿没有依据，先确认要不要保留`;
  const current = await approvedCutIdentity(source, dataDir, opts);
  const check = checkArtifactApproval({ artifact: "源视频成片", hash: from.sourceCutHash, approvedAt: from.at }, current.id);
  if (check.ok) return null;
  // 成片文件一分钟内刚写过：哈希先不算，不是换了版（verifier P3）
  if (current.id === null && current.reason.includes(STILL_SETTLING)) return "成片文件刚写完，等一分钟再判断（先不发）";
  return current.id === null
    ? `${current.reason}：这条是按旧成片做的，等新成片审过后用 rebind 绑到新成片（草稿都留着）`
    : `源视频换了一版成片（派生时 ${shortHash(from.sourceCutHash)}，现在 ${shortHash(current.id)}）：这条是按旧成片做的，用 rebind 绑到新成片（草稿都留着，按变化重审）`;
}

export async function isStale(item: Pick<Content, "derivedFrom">, dataDir: string, opts: { fresh?: boolean } = {}): Promise<boolean> {
  return (await staleReason(item, dataDir, opts)) !== null;
}
