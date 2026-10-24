/**
 * 源视频「审过的成片」身份（派生线判过期、派生、发布前核对共用）。
 *
 * - 按本体走的视频稿：当前有效成片批准所绑文件的 sha256（validCutApproval）。批准记录里的指纹不够——
 *   文件被覆盖 / 删掉后记录照旧，所以还要核文件本身（publish-gate.fileOf）：
 *   `fresh: true`（派生、发布）现算整文件哈希；`fresh: false`（看板）走元数据缓存（大小 + 修改时间没变就用缓存的哈希），
 *   不在每次刷看板时重算 GB 级成片。
 * - 旧流程稿：`videoDone.renderedRevision`（旧流程只有渲染代次，没有文件指纹可核）。
 * 两种身份带前缀区分。
 */
import type { Content } from "../../storage/local-store.js";
import { contentRoot } from "../../storage/content-project.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { validCutApproval } from "../production/derive.js";
import { fileOf, ontologyApplies } from "../production/publish-gate.js";
import { loadHashCache } from "../production/hash-cache.js";

export type CutIdentity = { id: string; reason?: undefined } | { id: null; reason: string };

export async function approvedCutIdentity(content: Content, dataDir: string, opts: { fresh?: boolean } = {}): Promise<CutIdentity> {
  if (!(await ontologyApplies(content, dataDir))) {
    return content.videoDone ? { id: `legacy-rev:${content.videoDone.renderedRevision}` } : { id: null, reason: "源视频还没有审过的成片（或重开了剪辑）" };
  }
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  // 从旧流程导入的老视频：有导入的成片事实、但从没在本体里审过片（没有任何 cut 决定）→ 沿用旧流程的成片完成标记。
  // 以后在本体里真审过一次，身份就换成文件指纹，之前派生的稿会如实报过期（走 rebind）。
  if (content.videoDone && !doc.decisions.some((d) => d.type === "cut_approval" || d.type === "cut_reject")) {
    return { id: `legacy-rev:${content.videoDone.renderedRevision}` };
  }
  const approval = validCutApproval(doc, content.body);
  if (!approval?.sha256) return { id: null, reason: "源视频的成片现在没有有效的审片通过（撤批、打回或重开了剪辑）" };
  const fact = doc.facts.find((f) => f.kind === "cut" && f.sha256 === approval.sha256 && !f.replaced_at);
  await loadHashCache(dataDir);
  const file = await fileOf(contentRoot(content.id, dataDir), fact, "源成片", opts.fresh === true);
  if (typeof file !== "string") return { id: null, reason: file.error };
  return { id: `sha256:${approval.sha256}` };
}
