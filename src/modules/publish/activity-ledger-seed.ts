/**
 * 首次建账（spec「首次建账」）：读各项目 06-publish/campaigns/*.json，把每个平台核查记录里「已选」的活动导进台账，
 * 保留原核查时间。只认按平台一份的标准结构（platform + checked_at + selected）；别的结构、缺必填的条目一律列出来，不猜。
 * 单条视频的排除项（excluded）不导：那是这条片子的判断，不是账号层面的 not_for_us。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { validateRecordInput, activityKey, type RecordInput } from "./activity-ledger.js";
import { mutateLedger, readLedger } from "./activity-ledger-store.js";

type Obj = Record<string, unknown>;
export interface SeedReport {
  scanned: number;
  imported: Array<{ key: string; name: string; verified_at: string; file: string }>;
  superseded: Array<{ key: string; file: string; reason: string }>;
  unreadable: Array<{ file: string; reason: string }>;
  skipped_exclusions: Array<{ file: string; name: string }>;
  already_in_ledger: Array<{ key: string; file: string }>;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const RULE_KEYS = ["rules_verified", "main_topic", "subtopic", "subtopic_count", "required_mentions", "registration_entry", "first_release_or_exclusivity", "other_constraints", "title_prefix"];

async function campaignFiles(dataDir: string): Promise<string[]> {
  const root = path.join(dataDir, "projects");
  let dirs: string[];
  try { dirs = await fs.readdir(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const out: string[] = [];
  for (const d of dirs.sort()) {
    const dir = path.join(root, d, "06-publish", "campaigns");
    let names: string[];
    try { names = await fs.readdir(dir); } catch { continue; }
    out.push(...names.filter((n) => n.endsWith(".json")).sort().map((n) => path.join(dir, n)));
  }
  return out;
}

/** 已选活动 → 台账入参；平台活动 ID 只收纯数字/字母 ID，「未知（…）」之类不当 ID */
export function selectedToInput(doc: Obj, sel: Obj, file: string): Obj {
  const w = isObj(sel.window) ? sel.window : {};
  const id = s(sel.activity_id);
  const rules = Object.fromEntries(RULE_KEYS.filter((k) => sel[k] !== undefined).map((k) => [k, sel[k]]));
  const formUrl = s(sel.post_publish_form);
  return {
    platform: doc.platform, name: sel.name, official_url: sel.official_url,
    platform_activity_id: id && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined,
    window: {
      start: s(w.start) ?? s(w.calendar_start), end: s(w.end) ?? s(w.calendar_end),
      timezone: s(w.timezone)?.match(/[A-Za-z]+\/[A-Za-z_]+/)?.[0], raw: s(w.poster_window) ?? s(w.end_time_of_day),
    },
    rules, form: formUrl && /^https?:/.test(formUrl) ? { url: formUrl, deadline: s(sel.form_deadline) } : undefined,
    relevance: "fits_us", verified_at: doc.checked_at, verified_via: doc.checked_via,
    sources: doc.sources_checked ?? [sel.official_url], evidence: [file],
  };
}

/** 一个文件 → 可导入的入参，或读不懂的原因 */
export async function parseCampaignFile(file: string): Promise<{ input?: RecordInput; exclusions: string[]; error?: string }> {
  let doc: unknown;
  try { doc = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (e) { return { exclusions: [], error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }; }
  if (!isObj(doc) || !s(doc.platform) || !s(doc.checked_at) || !("selected" in doc)) return { exclusions: [], error: "不是按平台一份的核查记录（缺 platform / checked_at / selected）" };
  const exclusions = (Array.isArray(doc.excluded) ? doc.excluded : []).map((x) => (isObj(x) ? String(x.name ?? "") : "")).filter(Boolean);
  if (!isObj(doc.selected)) return { exclusions, error: "这次没有选中活动（selected 为空），无可导入条目" };
  const v = validateRecordInput(selectedToInput(doc, doc.selected, file));
  return v.ok ? { input: v.input, exclusions } : { exclusions, error: `已选活动缺必填：${v.error}` };
}

/** 同一 key 多个来源：留核查时间最新的；台账里已有更新的不覆盖 */
export async function seedLedger(opts: { dataDir?: string; write: boolean }): Promise<SeedReport> {
  const dataDir = getDataDir(opts.dataDir);
  const files = await campaignFiles(dataDir);
  const report: SeedReport = { scanned: files.length, imported: [], superseded: [], unreadable: [], skipped_exclusions: [], already_in_ledger: [] };
  const best = new Map<string, { input: RecordInput; file: string }>();
  for (const file of files) {
    const r = await parseCampaignFile(file);
    report.skipped_exclusions.push(...r.exclusions.map((name) => ({ file, name })));
    if (!r.input) { report.unreadable.push({ file, reason: r.error ?? "未知" }); continue; }
    const key = activityKey(r.input.platform, r.input.name, r.input.platform_activity_id);
    const prev = best.get(key);
    if (prev && Date.parse(prev.input.verified_at) >= Date.parse(r.input.verified_at)) { report.superseded.push({ key, file, reason: "同一活动有更新的核查" }); continue; }
    if (prev) report.superseded.push({ key, file: prev.file, reason: "同一活动有更新的核查" });
    best.set(key, { input: r.input, file });
  }
  // 只补台账里没有的 key：已有条目（可能带后续核查、not_for_us 判断、history）一律不动
  const existing = (await readLedger(dataDir)).activities;
  for (const [key, { input, file }] of best) {
    if (existing[key]) { report.already_in_ledger.push({ key, file }); best.delete(key); continue; }
    report.imported.push({ key, name: input.name, verified_at: input.verified_at, file });
  }
  if (opts.write && best.size) await mutateLedger(dataDir, (l) => {
    for (const [key, { input }] of best) {
      if (l.activities[key]) continue;
      const { founder_quote: _q, ...fields } = input;
      l.activities[key] = { ...fields, key, history: [] };
    }
  });
  return report;
}
