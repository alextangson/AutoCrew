/**
 * 看板数据（看板规格 A/D/E）：一次读出看板要的全部事实。**只读，零写入**（本体 spec §4）。
 * 列归属一律用 explain()（与我的内容、晨报、desk 同一个），不另立口径；本体未启用时 explain 按旧状态给列（影子模式）。
 * 发布记录已投出的待发布稿由 explain 直接归到已发布——从前在这里读时改状态（syncPublished），现已删除。
 */
import { cachedSha } from "../modules/production/hash-cache.js";
import fs from "node:fs/promises";
import path from "node:path";
import { listContents, listTopics, type Content, type Topic } from "../storage/local-store.js";
import { isImportedHistory } from "../storage/imported-history.js";
import { scriptText } from "../storage/my-content-plan.js";
import { explainContent, explainContext, type ExplainContext } from "../modules/production/read.js";
import { readReconcileReport, type ReconcileReport } from "../modules/production/reconcile.js";
import type { CandidateView } from "../modules/production/derive.js";
import type { Column } from "../modules/production/explain.js";
import { isMissing, resolveContentProject } from "../storage/content-project.js";
import { readPublishRecord, recordTime, type PublishRecord } from "../storage/publish-record.js";
import { isVideoPlatform } from "../storage/stage-guard.js";
import { readProductionDoc } from "../storage/production-store.js";
import { storyboards, versionLabel } from "../modules/production/storyboard.js";
import { inCurrentSlate, latestMeetingDate } from "../modules/meetings/meeting-store.js";
import { editorLabel } from "../modules/production/workbench.js";
import { draftRef } from "../modules/production/inbox.js";
import { isBeingWritten } from "../modules/production/trash-guard.js";
import { handoffView, type HandoffView } from "../modules/production/handoff-view.js";
export { handoffView };
import { publishTargets, type PublishTarget } from "../modules/production/targets.js";
import { staleReason } from "../modules/lineage/lineage.js";
import { loadProfile, type CreatorProfile } from "../modules/profile/creator-profile.js";
import { allowedKitPlatforms, enKitPlatforms, lineStoppedReason } from "../modules/profile/platform-lines.js";
import { videoKitsOf } from "../storage/video-kits.js";

export { isBeingWritten };

export type BoardColumn = "选题" | Column;

export interface BoardCover { path: string; sha256: string }

export interface BoardItem {
  id: string;
  title: string;
  platform: string | null;
  status: string;
  topicId: string | null;
  /** 试跑示例稿（O20）：卡上标「示例」并给一键删 */
  example?: boolean;
  column: Exclude<BoardColumn, "选题">;
  createdAt: string;
  updatedAt: string;
  draftReadyAt: string | null;
  /** 正文字数（去掉空白），配合 wordsPerMinute 估时长（§29） */
  chars: number;
  finalDurationMs: number | null;
  /** 当前交接代次的清单哈希：撤回时带上，确认框开着期间换了代次就拒（不误撤新一代） */
  handoffHash: string | null;
  cover: BoardCover | null;
  /** 只有待发布 / 已发布的稿件才读发布记录 */
  publish: PublishRecord | null;
  /** 排序用的发布时间（§19） */
  publishTime: string | null;
  lastError: string | null;
  blockedReason: string | null;
  /** explain()：还差什么、徽章、候选（未启用本体时是影子结果之外的旧列，这三样为空） */
  missing: string[];
  /** 最新一版分镜的版本号（「v001」）；没有分镜 / 不按本体走 = null */
  storyboard?: string | null;
  /** 谁在剪：Claude / Codex / WorkBuddy / 你 / agent */
  editorLabel?: string;
  /** 「稿子写好了」这件事的身份与代次（稿子在 draft_ready 时有） */
  draftRef?: { item_id: string; gen: string };
  badges: string[];
  /** 真有问题的提示（卡上标红）：未登记就发布、文件不见了、被驳回… */
  alerts: string[];
  /** 一句人话原因 */
  reason: string;
  candidates: CandidateView[];
  /** 这张卡按本体走（资料库已启用、没被排除、视频稿）：点开面板、拖动按 §10 规则；否则走旧流程 */
  active: boolean;
  /** 正在写（后台生成占位稿或还活着的写手认领）：看板不许移入回收站 */
  writing: boolean;
  /** 视频稿的各发布平台（一条视频一张卡）：状态 + 这个平台还剩什么动作；文字稿 = [] */
  targets: PublishTarget[];
  /** 只有回执、没走认稿就发了：只提醒 */
  noScriptApproval: boolean;
  /** 本轮轮次（按平台动作要带它）；不按本体走 = null */
  round: number | null;
  /** 派生稿（英文版 / 公众号文章）的源成片换了：人话原因；不是派生稿或没过期 = null */
  derivedStale: string | null;
  /** 「在别的平台发了？」能列的平台：中文视频 = 四个中文平台；英文版 = 用户勾了的英文平台 */
  kitPlatforms: string[];
  /** 「开始写」交给了谁、有没有 agent 接手、谁正认领着（spec 2026-10-15 §B5）；没交过 = 不带 */
  handoff?: HandoffView;
}

export interface BoardTopic {
  id: string;
  title: string;
  source: string | null;
  link: string | null;
  score: number | null;
  createdAt: string;
  renewedAt: string | null;
  /** 在本周片单里（选题会 spec §0.3）：会议位指向最近一次会议 → 选题列置顶 + 标签；选中≠开工 */
  inSlate: boolean;
  /** 试跑示例（O20）：卡上标「示例」并给一键删 */
  example?: boolean;
}

export interface BoardData {
  items: BoardItem[];
  topics: BoardTopic[];
  /** 上一条已登记成片的「字数 ÷ 分钟」；没有登记过成片 = null（不显示估时，§29） */
  wordsPerMinute: number | null;
  /** 本体状态（§4.1）：是否已启用；未启用时给最近一次对账算出的「要挪 N 张卡」清单；对账失败逐条列出 */
  ontology: { enabled: boolean; report: ReconcileReport | null };
}

/** 数字数：去掉空白与 markdown 标题记号，中文按字、英文按字母 */
export function countChars(text: string): number {
  return text.replace(/^#.*$/m, "").replace(/\s+/g, "").length;
}

const PUBLISH_STATUSES = new Set(["publish_ready", "publishing", "published"]);

/** 已选那版的 3:4（选用 / 登记时拷成 05-cover/封面-3x4.*）；没选就不放图（§30） */
export async function coverOf(contentId: string, dataDir: string): Promise<BoardCover | null> {
  const binding = resolveContentProject(contentId, dataDir);
  if (!binding) return null;
  let names: string[];
  try { names = await fs.readdir(path.join(binding.project_root, "05-cover")); } catch (e) { if (isMissing(e)) return null; throw e; }
  const name = names.find((n) => /^封面-3x4\.(png|jpe?g)$/i.test(n));
  if (!name) return null;
  const rel = `05-cover/${name}`;
  return { path: rel, sha256: (await cachedSha(path.join(binding.project_root, rel))).sha256 };
}

/** 最近一条已登记成片的语速：定稿字数 ÷ 成片分钟数 */
export async function wordsPerMinute(contents: Content[], dataDir: string): Promise<number | null> {
  const last = contents.filter((c) => c.video?.final && c.video.final.duration_ms > 0)
    .sort((a, b) => (b.video!.final!.at).localeCompare(a.video!.final!.at))[0];
  if (!last) return null;
  const binding = resolveContentProject(last.id, dataDir);
  const script = binding ? await scriptText(last, binding.project_root).catch(() => null) : null;
  const chars = countChars(script ?? last.body);
  if (!chars) return null;
  return chars / (last.video!.final!.duration_ms / 60_000);
}

/** 看板卡片信息行的「分镜 vNNN」：最新一版分镜（spec 2026-09-30-storyboard-review-check §4） */
async function productionInfo(id: string, dataDir: string): Promise<{ storyboard: string | null; editorLabel: string }> {
  const doc = await readProductionDoc(id, dataDir).catch(() => null);
  const latest = doc ? storyboards(doc)[0] : undefined;
  // 谁在剪（review-inbox §10）：按事实的 by.host 显示真实 agent，不写死「Codex」
  return { storyboard: latest ? versionLabel(latest.version) : null, editorLabel: doc ? editorLabel(doc) : "agent" };
}

async function itemOf(c: Content, dataDir: string, ctx: ExplainContext, profile: CreatorProfile | null): Promise<BoardItem | null> {
  const current = c;
  // 视频稿总读发布计划：平台标签要计划里的平台清单（吸收 13）
  const publish: PublishRecord | null = PUBLISH_STATUSES.has(c.status) || c.manualPublications?.length || isVideoPlatform(c.platform)
    ? await readPublishRecord(c.id, c.manualPublications, dataDir) : null;
  const exp = await explainContent(c, dataDir, ctx, publish);
  const col = exp.column;
  const active = ctx.enabled && !ctx.excluded.has(current.id) && isVideoPlatform(current.platform);
  // 归档 / 未知状态 / 选题占位不进任何列（§6）
  if (!col) return null;
  const doc = isVideoPlatform(current.platform) ? await readProductionDoc(current.id, dataDir).catch(() => null) : null;
  return {
    targets: publishTargets(current, doc, publish, active, current.derivedFrom?.kind === "en_edition" ? enKitPlatforms(profile) : []), noScriptApproval: exp.no_script_approval === true, round: active ? doc?.round ?? 1 : null,
    id: current.id, title: current.title, platform: current.platform ?? null, status: current.status,
    topicId: current.topicId ?? null, ...(current.example ? { example: true } : {}), column: col, createdAt: current.createdAt, updatedAt: current.updatedAt,
    draftReadyAt: current.draftReadyAt ?? null, chars: countChars(current.body ?? ""),
    finalDurationMs: current.video?.final?.duration_ms ?? null,
    handoffHash: current.video?.handoff?.hash ?? null,
    cover: col === "待发布" || col === "已发布" ? await coverOf(current.id, dataDir).catch(() => null) : null,
    publish, publishTime: publish ? recordTime(publish) ?? current.publishedAt : current.publishedAt,
    lastError: current.lastError ?? null, blockedReason: current.blockedReason ?? null,
    active, writing: isBeingWritten(current), derivedStale: await boardStale(current, dataDir), kitPlatforms: allowedKitPlatforms(current.platform, profile), ...(handoffView(current) ? { handoff: handoffView(current)! } : {}),
    missing: exp.missing, badges: exp.badges, alerts: [...exp.alerts, ...stoppedAlerts(current, profile)], reason: exp.reason, candidates: exp.candidates,
    ...(active ? await productionInfo(current.id, dataDir) : { storyboard: null }),
    // 看板拖「写稿中 → 待录制」认稿要带它（整分支审 4 P1）
    ...(draftRef(current) ? { draftRef: draftRef(current)! } : {}),
  };
}

/** 取消勾选停掉的派生线（spec §9.2）：整条线停了 / 英文版某一路停了（交过包的那一路才提）；和出口拒收用同一句话 */
function stoppedAlerts(c: Content, profile: CreatorProfile | null): string[] {
  const kind = c.derivedFrom?.kind;
  if (!kind) return [];
  const whole = lineStoppedReason(profile, kind);
  if (whole) return [whole];
  if (kind !== "en_edition") return [];
  return Object.keys(videoKitsOf(c)).map((p) => lineStoppedReason(profile, kind, p)).filter((x): x is string => Boolean(x));
}

/** 看板读源状态（走哈希缓存，不现算）；一条读坏不拖垮整板，卡上照样标出来 */
async function boardStale(c: Content, dataDir: string): Promise<string | null> {
  try { return await staleReason(c, dataDir); }
  catch (e) { return `来源状态读不出来：${e instanceof Error ? e.message : String(e)}`; }
}

function topicOf(t: Topic, latestMeeting: string | null): BoardTopic {
  return { id: t.id, title: t.title, source: t.source ?? null, link: t.link ?? null, score: typeof t.score === "number" ? t.score : null, createdAt: t.createdAt, renewedAt: t.renewedAt ?? null,
    inSlate: inCurrentSlate(t, latestMeeting), ...(t.example ? { example: true } : {}) };
}

export async function boardData(dataDir: string): Promise<BoardData> {
  const [all, topics, ctx] = await Promise.all([listContents(dataDir), listTopics(dataDir), explainContext(dataDir)]);
  // 历史作品记录只挂回流数据，不是生产稿，不上看板
  const contents = all.filter((c) => !isImportedHistory(c));
  const items: BoardItem[] = [];
  const profile = await loadProfile(dataDir);
  for (const c of contents) {
    const item = await itemOf(c, dataDir, ctx, profile);
    if (item) items.push(item);
  }
  const started = new Set(contents.filter((c) => c.topicId).map((c) => c.topicId!));
  const latestMeeting = await latestMeetingDate(dataDir);
  return {
    items,
    topics: topics.filter((t) => !started.has(t.id)).map((t) => topicOf(t, latestMeeting)),
    wordsPerMinute: await wordsPerMinute(contents, dataDir),
    ontology: { enabled: ctx.enabled, report: await readReconcileReport(dataDir) },
  };
}
