import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomic, writeTextAtomic } from "../../storage/json-atomic.js";
import { gatherInsightsFacts, type InsightsFacts, type InsightsOptions } from "./facts.js";
import { INSIGHTS_INSTRUCTIONS, validateInsightsReport, renderInsightsReport, type InsightsReport } from "./report.js";

const ID_RE = /^insights-[a-f0-9-]{36}$/;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function insightsHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function base(dataDir?: string) { return path.join(getDataDir(dataDir), "reports", "account-insights"); }
function folder(id: string, dataDir?: string) {
  if (!ID_RE.test(id)) throw new Error("无效pack_id，请使用prepare返回的ID");
  return path.join(base(dataDir), id);
}
interface Pack { id: string; evidenceHash: string; facts: InsightsFacts }
interface Saved {
  id: string; savedAt: string; analyzedBy: string; evidenceHash: string; reportHash: string; markdownHash: string;
  report: InsightsReport; markdown: string;
}

export async function prepareInsights(opts: InsightsOptions, dataDir?: string) {
  const facts = await gatherInsightsFacts(opts, dataDir);
  const id = `insights-${randomUUID()}`;
  const evidenceHash = insightsHash(facts);
  const dir = folder(id, dataDir);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, "pack.json"), { id, evidenceHash, facts });
  return { ok: true, status: "ready_for_host_analysis", pack_id: id, evidence_hash: evidenceHash, facts,
    instructions: INSIGHTS_INSTRUCTIONS, next_action: "由当前宿主基于本包分析，然后autocrew_insights submit{pack_id,evidence_hash,report}；保存成功后把报告交给用户。", model_invoked: false };
}

async function readPack(id: string, dataDir?: string): Promise<Pack> {
  const pack = JSON.parse(await fs.readFile(path.join(folder(id, dataDir), "pack.json"), "utf8")) as Pack;
  if (pack.id !== id || insightsHash(pack.facts) !== pack.evidenceHash) throw new Error("事实包内容校验失败，请重新prepare");
  return pack;
}

function validateSaved(saved: Saved, pack: Pack): Saved {
  const report = validateInsightsReport(saved.report, pack.facts);
  if (saved.id !== pack.id || saved.evidenceHash !== pack.evidenceHash ||
      saved.reportHash !== insightsHash(report) || typeof saved.markdown !== "string" || saved.markdownHash !== insightsHash(saved.markdown)) {
    throw new Error("已保存报告内容校验失败，请检查报告文件；不会覆盖或把损坏报告当作完成");
  }
  return saved;
}

const writes = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (writes.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(() => undefined, () => undefined);
  writes.set(key, tail);
  void tail.then(() => { if (writes.get(key) === tail) writes.delete(key); });
  return next;
}

export async function submitInsights(id: string, evidenceHash: string, raw: unknown, host: string, dataDir?: string) {
  const dir = folder(id, dataDir);
  return serialized(dir, async () => {
    const pack = await readPack(id, dataDir);
    if (pack.evidenceHash !== evidenceHash) throw new Error("evidence_hash不匹配；请使用同一次prepare的资料和hash提交");
    const report = validateInsightsReport(raw, pack.facts);
    const reportHash = insightsHash(report);
    const file = path.join(dir, "report.json");
    let existing: Saved | null = null;
    try { existing = validateSaved(JSON.parse(await fs.readFile(file, "utf8")) as Saved, pack); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (existing && existing.reportHash !== reportHash) throw new Error("此事实包已有不同报告，不覆盖；需要新一轮洞察请重新prepare");
    const markdown = renderInsightsReport(report, pack.facts, id);
    const saved: Saved = existing ?? { id, savedAt: new Date().toISOString(), analyzedBy: host, evidenceHash, reportHash,
      report, markdown, markdownHash: insightsHash(markdown) };
    if (!existing) await writeJsonAtomic(file, saved);
    // JSON为提交事实源；中途失败重试时重建同一份可阅读报告。
    await writeTextAtomic(path.join(dir, "report.md"), saved.markdown);
    return { ok: true, status: "saved", pack_id: id, file: path.join(dir, "report.md"), markdown: saved.markdown,
      repeated: !!existing, advice_only: true, actions_executed: false, model_invoked: false };
  });
}

export async function getInsights(id: string, dataDir?: string) {
  const pack = await readPack(id, dataDir);
  let saved: Saved;
  try { saved = validateSaved(JSON.parse(await fs.readFile(path.join(folder(id, dataDir), "report.json"), "utf8")) as Saved, pack); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { ok: true, status: "ready_for_host_analysis", pack_id: id, evidence_hash: pack.evidenceHash, facts: pack.facts, instructions: INSIGHTS_INSTRUCTIONS };
  }
  const file = path.join(folder(id, dataDir), "report.md");
  // JSON已提交但Markdown写入被中断时，回读仍交付真实存在的文件。
  try { await fs.access(file); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await writeTextAtomic(file, saved.markdown);
  }
  return { ok: true, status: "saved", pack_id: id, file, ...saved, facts: pack.facts, actions_executed: false };
}

export async function listInsights(dataDir?: string) {
  let ids: string[];
  try { ids = await fs.readdir(base(dataDir)); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
  const records = await Promise.all(ids.filter((id) => ID_RE.test(id)).map(async (id) => {
    const result = await getInsights(id, dataDir);
    return { pack_id: id, status: result.status, generatedAt: result.facts.generatedAt, window: result.facts.window,
      ...(result.status === "saved" && "savedAt" in result ? { savedAt: result.savedAt, file: result.file } : {}) };
  }));
  return records.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}
