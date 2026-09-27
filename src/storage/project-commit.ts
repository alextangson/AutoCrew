/** A redo journal gives multi-file exports a recoverable commit boundary on ordinary files. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Content } from "./local-store.js";
import { projectFile, resolveContentProject, isMissing, safeProjectPath } from "./content-project.js";
import { writeJsonAtomic, writeTextAtomic } from "./json-atomic.js";
import { portableProjectRecord } from "./project-record.js";
import { assertManagedPathAvailable } from "./storage-roots.js";

function contentRevision(content: Content, root: string): string {
  return createHash("sha256").update(JSON.stringify(portableProjectRecord(content, root))).digest("hex");
}
async function rawMeta(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch (e) { if (isMissing(e)) return null; throw e; }
}

async function text(file: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeTextAtomic(file, value);
}
export async function exportProjectViews(content: Content, root: string): Promise<void> {
  const files: Record<string, string> = {};
  const projection = async (file: string, value: string) => {
    files[path.relative(root, file)] = createHash("sha256").update(value).digest("hex");
    await text(file, value);
  };
  const revision = contentRevision(content, root);
  await projection(projectFile(root, "draft.md"), content.body);
  for (const version of content.versions) await projection(projectFile(root, "versions", `v${version.version}.md`), version.body);
  await projection(path.join(root, "01-script/evidence/ledger.json"), JSON.stringify(content.evidenceLedger ?? [], null, 2));
  await projection(path.join(root, "01-script/reviews/current.json"), JSON.stringify({ generated: true, revision, review: content.review ?? null }, null, 2));
  if (content.videoKit) {
    await projection(path.join(root, "06-publish/copy", `${content.platform ?? "unknown"}.json`), JSON.stringify({ generated: true, revision, kit: content.videoKit }, null, 2));
    await projection(path.join(root, "06-publish/packages", `${revision}.json`), JSON.stringify({ generated: true, content_id: content.id, kit: content.videoKit, final: content.video?.final ?? null }, null, 2));
  }
  if (content.publishedAt || content.publishUrl) await projection(path.join(root, "06-publish/receipts/current.json"), JSON.stringify({ generated: true, revision, publishedAt: content.publishedAt, publishUrl: content.publishUrl }, null, 2));
  if (Object.keys(content.performanceData ?? {}).length) await projection(path.join(root, "06-publish/metrics", `${revision}.json`), JSON.stringify({ generated: true, revision, recorded_at: content.updatedAt, metrics: content.performanceData }, null, 2));
  await projection(path.join(root, "项目信息.md"), `# ${content.title}\n\nAutoCrew 生成的只读视图；请通过服务修改。\n\n- content_id: ${content.id}\n- 状态: ${content.status}\n- 版本: ${content.versions.length}\n- 来源 SHA-256: ${revision}\n`);
  await projection(path.join(root, "项目导航.md"), "# 项目导航\n\nAutoCrew 生成。\n\n" + [
    ["文稿", "01-script/manuscripts"], ["调研", "01-script/research"], ["来源原件", "01-script/references"],
    ["证据与出处", "01-script/evidence"], ["交接包", "01-script/handoff"], ["口播", "02-aroll"], ["画面素材", "03-broll"],
    ["工程", "04-edit"], ["声音", "05-audio"], ["封面", "05-cover"], ["发布与回流", "06-publish"], ["交付", "07-delivery"],
  ].map(([label, href]) => `- [${label}](${href}/)`).join("\n") + "\n");
  let execution: unknown = null;
  try { execution = JSON.parse(await fs.readFile(projectFile(root, "execution.json"), "utf8")); }
  catch (e) { if (!isMissing(e)) throw e; }
  let approvals: unknown = null;
  try { approvals = JSON.parse(await fs.readFile(projectFile(root, "approvals.json"), "utf8")); }
  catch (e) { if (!isMissing(e)) throw e; }
  const stored = approvals as Record<string, unknown> | null;
  const gateRecord = stored?.source === "founder-workbench" && stored.manifest_hash === content.video?.handoff?.hash && stored.generation === content.video?.handoff?.generation ? stored : null;
  const gates = Object.fromEntries(["rough_cut", "storyboard", "final_cut", "covers"].map((name, i) => [
    `gate${i + 1}`, { status: gateRecord?.[name] ? "approved" : "pending", approval: gateRecord?.[name] ?? null },
  ]));
  await projection(path.join(root, "00-project/notes/workflow-state.json"), JSON.stringify({ generated: true, revision,
    content_id: content.id, status: content.status, generation: content.video?.handoff?.generation ?? null, execution, approvals: gateRecord, gates }, null, 2));
  await writeJsonAtomic(projectFile(root, "view-manifest.json"), { revision, files });
}
export async function commitProjectContent(content: Content, dataDir?: string): Promise<boolean> {
  const binding = resolveContentProject(content.id, dataDir);
  if (!binding) return false;
  const root = binding.project_root;
  const task = (async () => {
    const meta = projectFile(root, "meta.json"), pending = projectFile(root, "content-pending.json");
    const previous = await rawMeta(meta);
    const intended = JSON.stringify(portableProjectRecord(content, root), null, 2);
    let reachedMeta = false;
    try {
      await writeJsonAtomic(pending, { version: 1, content: portableProjectRecord(content, root) });
      await finish(content, root, () => { reachedMeta = true; });
    } catch (cause) {
      // A caught failure is not a power loss. Cancel an uncommitted update so
      // a caller's rollback/read cannot accidentally redo its failed transition.
      try {
        const current = await rawMeta(meta);
        if (reachedMeta && current === intended) { await fs.unlink(pending).catch(() => {}); return; }
        if (current !== previous || previous === null) throw new Error("commit outcome requires recovery");
        assertManagedPathAvailable(pending);
        await fs.unlink(pending).catch(e => { if (!isMissing(e)) throw e; });
      } catch {
        throw Object.assign(new Error("project_commit_uncertain: 写入结果待恢复；保留事务日志，不能假定状态已回滚。", { cause }), { code: "PROJECT_COMMIT_UNCERTAIN" });
      }
      // Export may have finished before meta failed. Its revision is checked by
      // repairProjectViews; repairing it is best effort, never the commit point.
      await exportProjectViews(portableProjectRecord(JSON.parse(previous!), root, true), root).catch(() => {});
      throw cause;
    }
  })();
  recovering.set(root, task);
  try { await task; } finally { recovering.delete(root); }
  return true;
}
async function finish(content: Content, root: string, beforeMeta?: () => void): Promise<void> {
  await exportProjectViews(content, root);
  beforeMeta?.();
  await writeJsonAtomic(projectFile(root, "meta.json"), portableProjectRecord(content, root));
  // Metadata committed: cleanup failure must not trigger a caller's rollback.
  await fs.unlink(projectFile(root, "content-pending.json")).catch(() => {});
}
const recovering = new Map<string, Promise<void>>();
export async function recoverProjectContent(id: string, dataDir?: string): Promise<void> {
  const binding = resolveContentProject(id, dataDir);
  if (!binding) return;
  const root = binding.project_root;
  const active = recovering.get(root);
  if (active) return active;
  const task = (async () => {
    let pending: { version: number; content: Content };
    try { pending = JSON.parse(await fs.readFile(projectFile(root, "content-pending.json"), "utf8")); }
    catch (e) { if (isMissing(e)) return; throw e; }
    if (pending.version !== 1 || pending.content.id !== id) throw new Error(`project_journal_invalid: ${id}`);
    await finish(portableProjectRecord(pending.content, root, true), root);
  })();
  recovering.set(root, task);
  try { await task; } finally { recovering.delete(root); }
}

/** Rebuild only generated views; never ingest a hand-edited status/approval field. */
export async function repairProjectViews(content: Content, root: string): Promise<string[]> {
  let manifest: { revision: string; files: Record<string, string> };
  try { manifest = JSON.parse(await fs.readFile(projectFile(root, "view-manifest.json"), "utf8")); }
  catch (e) { if (!isMissing(e)) throw e; await exportProjectViews(content, root); return ["view-manifest.json"]; }
  const drift: string[] = [];
  if (manifest.revision !== contentRevision(content, root)) drift.push("source-revision");
  for (const [relative, hash] of Object.entries(manifest.files)) {
    const file = safeProjectPath(root, relative);
    try { if (createHash("sha256").update(await fs.readFile(file)).digest("hex") !== hash) drift.push(relative); }
    catch (e) { if (!isMissing(e)) throw e; drift.push(relative); }
  }
  if (drift.length) await exportProjectViews(content, root);
  return drift;
}
