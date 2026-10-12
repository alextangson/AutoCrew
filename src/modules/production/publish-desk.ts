/**
 * 发布台页面读模型（spec 2026-10-12 发布台 吸收 8）：一次返回卡片面板 + 各平台行 + 以前的发布 + 封面 + 定稿标识 + 进度栏。
 * 只给本体启用的视频稿（吸收 7）；影子 / 被排除 / 文字稿返回 active:false，页面照旧用原来的。只读。
 */
import { getContent, listContents } from "../../storage/local-store.js";
import { bodyHash, readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { ProductionDoc } from "../../storage/production-types.js";
import { readPublishRecord } from "../../storage/publish-record.js";
import { readPullState, type MetricsPullState } from "../flywheel/pull-state.js";
import { backflowOf } from "../flywheel/backflow.js";
import { platformBaselines } from "../flywheel/compare.js";
import type { DataRow } from "../flywheel/data-rows.js";
import { dataRows } from "../../desktop/data-page.js";
import { countChars, wordsPerMinute } from "../../desktop/board-data.js";
import { cardPanel } from "./panel.js";
import { overdueSchedule, slotOf } from "./receipts.js";
import { planEntryFor } from "./desk-plan.js";
import { validCoverApproval } from "./derive.js";
import { deskRow, type DeskRow } from "./desk-rows.js";
import { railSteps } from "./desk-rail.js";
import type { PublishTarget } from "./targets.js";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 当前有效的封面：封面批准 / 本轮登记里的那组 3:4，不按文件名找（吸收 13） */
function coverOf(doc: ProductionDoc, body: string, contentId: string): { fact_id: string; url: string } | null {
  const sha = validCoverApproval(doc, body)?.cover_3x4_sha ?? doc.registrations.filter((r) => r.round === doc.round).at(-1)?.cover_3x4_sha;
  const f = sha ? doc.facts.find((x) => x.kind === "cover" && x.sha256 === sha && x.round === doc.round) : undefined;
  return f ? { fact_id: f.id, url: `/api/inbox/media?content_id=${encodeURIComponent(contentId)}&fact_id=${encodeURIComponent(f.id)}` } : null;
}

/** 「定稿」只在认稿的正文哈希与当前正文一致时（吸收 13） */
function scriptOf(doc: ProductionDoc, body: string): { final: boolean; label: string } {
  const d = doc.decisions.filter((x) => x.round === doc.round && (x.type === "script_approval" || x.type === "script_revoke")).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  const final = d?.type === "script_approval" && d.body_hash === bodyHash(body);
  return { final, label: final ? "定稿" : "当前稿（未认）" };
}

/** 卡上没事可做时的一句（spec §2 / 吸收 1、9） */
function summaryOf(rows: DeskRow[]): string | null {
  const sched = rows.filter((r) => r.state === "已定时" && r.when).sort((a, b) => (a.times.scheduled_at ?? "").localeCompare(b.times.scheduled_at ?? ""))[0];
  if (sched) return `${sched.label}${sched.when}；公开后自动跟你平时比`;
  const pub = rows.find((r) => r.data.kind === "metrics");
  if (pub && pub.data.kind === "metrics") return `${pub.label}${pub.when ? ` ${pub.when}` : ""}：${pub.data.compare.text}`;
  return null;
}

async function readData(dataDir: string): Promise<{ rows: DataRow[]; pull: MetricsPullState | null; pullErr?: string; dataErr?: string }> {
  const [rows, pull] = await Promise.all([
    dataRows(dataDir).then((r) => ({ r }), (e) => ({ r: [] as DataRow[], e: err(e) })),
    readPullState(dataDir).then((s) => ({ s }), (e) => ({ s: null, e: err(e) })),
  ]);
  return { rows: rows.r, pull: pull.s, ...("e" in pull ? { pullErr: pull.e } : {}), ...("e" in rows ? { dataErr: rows.e } : {}) };
}

const earliest = (xs: Array<string | null | undefined>) => xs.filter((x): x is string => Boolean(x)).sort()[0] ?? null;

export async function publishDesk(contentId: string, dataDir: string, now = Date.now()): Promise<Record<string, unknown>> {
  const card = await cardPanel(contentId, dataDir);
  if (card.ok === false || !card.active) return { ok: card.ok !== false, ...(card.ok === false ? card : { active: false, card }) };
  const content = (await getContent(contentId, dataDir))!;
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const record = await readPublishRecord(content.id, content.manualPublications, dataDir);
  const data = await readData(dataDir);
  const baselines = platformBaselines(data.rows);
  const works = data.rows.flatMap((r) => r.works);
  const rows = (card.targets as PublishTarget[]).map((target) => { const slot = slotOf(doc, doc.round, target.platform); return deskRow({
    content, target, slot, entry: planEntryFor(doc, record, target.platform, slot),
    overdue: overdueSchedule(doc, doc.round, target.platform), works, baselines, now,
    backflow: data.dataErr ? { kind: "unreadable", auto: false, text: `数据读不出来：${data.dataErr}` } : backflowOf(target.platform, data.pull, data.pullErr),
  }); });
  const live = rows.filter((r) => ["已定时", "审核中", "已公开", "应已公开"].includes(r.state));
  const rail = railSteps({ doc, body: content.body, firstSubmitAt: earliest(live.map((r) => r.times.submitted_at ?? r.times.observed_at)),
    firstDataAt: earliest(rows.map((r) => (r.data.kind === "metrics" ? r.data.first_at : null))) });
  const wpm = await wordsPerMinute(await listContents(dataDir), dataDir).catch(() => null);
  return {
    ok: true, active: true, card,
    desk: {
      round: doc.round, rows, past: card.past_receipts ?? [],
      plan_error: record.kind === "unreadable" ? record.reason : null,
      headline: live.length ? `${live.length} 个平台已投出` : null, summary: summaryOf(rows),
      refresh_at: earliest(rows.map((r) => (r.times.scheduled_at && Date.parse(r.times.scheduled_at) > now ? r.times.scheduled_at : null))),
      cover: coverOf(doc, content.body, content.id), script: scriptOf(doc, content.body),
      rail: { steps: rail, platforms: rows.map((r) => r.label), chars: countChars(content.body ?? ""), wpm },
    },
  };
}
