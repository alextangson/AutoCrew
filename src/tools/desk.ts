/**
 * `autocrew_desk` — 三张待办桌与认领（P3 spec §6.1）。
 *
 * 员工不靠互相发消息协作（§2 明确不做），靠**桌子上有什么活**：写手看「选题选了立意卡但还没稿」，
 * 封面师看「进了封面台但还没定稿封面」，剪辑师看「在剪辑台但成片还没审过」。三张桌子的判据
 * 全部从既有状态与既有事实推出来，不新造一套任务表——任务表会和状态机各说各的。
 *
 * `claim` 给的那枚令牌是硬门（`src/storage/claims.ts`）：拿着它写才不会被另一个宿主的迟到写入盖掉。
 * 忘了 `release` 不要紧，30 分钟租约到期自动可被接管，接管在 `handoffs[]` 留账。
 */
import { Type } from "@sinclair/typebox";

import {
  claimContent,
  claimView,
  isClaimEmployee,
  releaseClaim,
  type ClaimView,
} from "../storage/claims.js";
import {
  getCoverReview,
  getDataDir,
  listContents,
  listTopics,
  LOCAL_HOST,
  type ClaimEmployee,
  type Content,
  type ContentStatus,
} from "../storage/local-store.js";
import { isVideoPlatform } from "../storage/stage-guard.js";
import { explainAll } from "../modules/production/read.js";
import { activeClaim } from "../storage/claims.js";
import { getContent } from "../storage/local-store.js";
import { pullDeps } from "../modules/video/handoff/pull-deps.js";
import {
  CUT_UNREGISTERED_NEXT_ACTION,
  scanUnregisteredCuts,
  type CutScanOptions,
  type CutSignals,
} from "../modules/video/unregistered-cut.js";

/**
 * 剪辑认领（交接签发、心跳续租）的接管要创始人在本机弹窗点确认（P6 §12.4-D）：
 * 模型自填的 takeover:true 不算数。不是剪辑认领就不弹，照旧走闲置规则。
 */
async function founderApprovesTakeover(contentId: string, host: string, dataDir: string): Promise<boolean> {
  const content = await getContent(contentId, dataDir);
  const current = content ? activeClaim(content) : null;
  if (!content || !current?.heartbeat) return false;
  const idleMin = Math.floor((Date.now() - Date.parse(current.lastWriteAt ?? current.at)) / 60_000);
  const answer = await pullDeps().dialog.ask({
    title: "AutoCrew 接管剪辑", timeoutSec: 300, buttons: ["取消", "接管"], defaultButton: "取消", cancelButton: "取消",
    prompt: `${host} 的另一个会话要接管「${content.title}」的剪辑。\n原会话 ${idleMin} 分钟没有报进度。\n接管后原会话的 report、register 都会被拒。`,
  });
  return answer.kind === "ok" && answer.value === "接管";
}

const ACTIONS = ["inbox", "claim", "release"] as const;

export const deskSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({
    type: "string",
    enum: [...ACTIONS],
    description: "inbox | claim | release",
  }),
  employee: Type.Optional(
    Type.Unsafe<ClaimEmployee>({
      type: "string",
      enum: ["writer", "cover", "editor"],
      description: "inbox / claim：哪张桌子 —— writer 写手 | cover 封面师 | editor 剪辑师",
    }),
  ),
  content_id: Type.Optional(Type.String({ description: "claim / release：稿件 id" })),
  claim_token: Type.Optional(
    Type.String({ description: "claim：带上手里的令牌 = 续约；release：claim 返回的令牌（对不上不给释放）" }),
  ),
  takeover: Type.Optional(
    Type.Boolean({ description: "claim：同宿主另一个会话认领着、你手里没它的令牌时，明确要接手才传 true（换新令牌并记交接）" }),
  ),
});

export const DESK_DESCRIPTION = [
  "AutoCrew 待办桌：看自己这一岗有什么活、认领、干完释放。",
  "1) inbox{employee}：writer=已选立意卡还没稿的选题 + 退回修订的稿；cover=过审待做封面的稿（公众号稿在 approved、视频稿在成片审过之后、以及退回封面台的）；editor=在剪辑台且成片还没审过的稿。每项带 content_id/topic_id/title/platform/status/claim；写手那张桌上 content_id 为 null 的是「还没建稿」，用 autocrew_writer pack 领包就会建。",
  "2) claim{content_id, employee, claim_token?, takeover?}：认领，拿 claim_token（租约 30 分钟）。别的宿主还握着未过期的租约会被拒并告诉你持有者是谁；带着令牌重复认领 = 续约、返回同一枚令牌；同宿主不带令牌 = claim_held；takeover:true 只在持有会话 10 分钟没写入后才生效，否则照样 claim_held（别替用户抢活，先问）；交接签发的剪辑认领不看闲置，takeover 会在创始人的 Mac 上弹窗，他点「接管」才换人、旧令牌作废。",
  "3) release{content_id, claim_token}：干完释放。忘了也不要紧——租约过期后别人可以接管，接管会记在交接台账里。",
  "纪律：认领之后的写操作（autocrew_writer submit / autocrew_cover_review 出图与批准 / autocrew_content update、transition）都带上 claim_token，那是防止两个宿主互相盖写的唯一凭据。",
].join("\n");

export interface DeskItem {
  /** 还没建稿的选题为 null——写手那张桌上专有的一种活 */
  content_id: string | null;
  topic_id?: string;
  title: string;
  platform?: string;
  status: ContentStatus;
  /** 已脱敏：令牌只回给认领者本人 */
  claim?: ClaimView;
  /** 剪辑师桌上「剪完未登记」的条目才有：和已派工的活分开数 */
  reason?: "cut_unregistered";
  signals?: CutSignals;
  next_action?: string;
}

type DeskResult = Record<string, unknown>;

function fail(error: string, extra: Record<string, unknown> = {}): DeskResult {
  return { ok: false, error, ...extra };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function itemOf(content: Content): DeskItem {
  return {
    content_id: content.id,
    ...(content.topicId ? { topic_id: content.topicId } : {}),
    title: content.title,
    ...(content.platform ? { platform: content.platform } : {}),
    status: content.status,
    ...(content.claim ? { claim: claimView(content.claim) } : {}),
  };
}

/**
 * 写手桌：选了立意卡但一篇稿都还没有的选题（`content_id: null`——领包时才建稿），
 * 加上被审稿退回修订的稿。归档稿不算「有稿」，那是被放弃的一次尝试。
 */
async function writerInbox(dataDir: string): Promise<DeskItem[]> {
  const [topics, contents] = await Promise.all([listTopics(dataDir), listContents(dataDir)]);
  const busyTopics = new Set(
    contents.filter((c) => c.topicId && c.status !== "archived").map((c) => c.topicId as string),
  );
  const fresh: DeskItem[] = topics
    .filter((t) => t.selectedAngle && !busyTopics.has(t.id))
    .map((t) => ({ content_id: null, topic_id: t.id, title: t.title, status: "topic_saved" as ContentStatus }));
  return [...fresh, ...contents.filter((c) => c.status === "revision").map(itemOf)];
}

/**
 * 封面师桌：要封面、封面还没定稿的稿（定稿判据 = 评审单上的 approvedLabel，与阶段门同一份）。
 * 真机 2026-09-06：状态机里非视频稿走 approved → publish_ready，根本不经过 cover_pending，
 * 只盯 cover_pending 的桌子对公众号稿永远是空的——封面在 approved 就该做；视频稿要等成片审过。
 */
function wantsCover(c: Content, column: string | null): boolean {
  if (!isVideoPlatform(c.platform)) return c.status === "approved";
  // 列归属用 explain()（本体 §2.6）：视频稿在剪辑中、且成片已审过（或旧封面台）才轮到封面
  return column === "剪辑中" && (c.status === "cover_pending" || Boolean(c.videoDone));
}

async function coverInbox(dataDir: string): Promise<DeskItem[]> {
  const all = await listContents(dataDir);
  const exp = await explainAll(all, dataDir);
  const contents = all.filter((c) => wantsCover(c, exp.get(c.id)?.column ?? null));
  const pending = await Promise.all(
    contents.map(async (c) => ((await getCoverReview(c.id, dataDir))?.approvedLabel ? null : itemOf(c))),
  );
  return pending.filter((item): item is DeskItem => item !== null);
}

/** 已派工：在剪辑台且这一版成片还没审过（`videoDone` 是阶段门唯一认的凭据） */
export async function dispatchedInbox(dataDir: string): Promise<DeskItem[]> {
  const all = await listContents(dataDir);
  const exp = await explainAll(all, dataDir);
  return all.filter((c) => exp.get(c.id)?.column === "剪辑中" && !c.videoDone).map(itemOf);
}

/**
 * 剪辑师桌 = 已派工 + 剪完未登记（带 reason，计数时按 reason 分开，两个桶互斥）。
 * warnings：导出目录读不了（非 ENOENT）时不静默。
 */
export async function editorInbox(dataDir: string, opts: CutScanOptions = {}): Promise<{ items: DeskItem[]; warnings: string[] }> {
  const contents = await listContents(dataDir);
  const scan = await scanUnregisteredCuts(contents, dataDir, opts);
  const cut: DeskItem[] = contents.filter((c) => scan.hits.has(c.id)).map((c) => ({
    ...itemOf(c),
    reason: "cut_unregistered",
    signals: scan.hits.get(c.id),
    next_action: CUT_UNREGISTERED_NEXT_ACTION,
  }));
  return { items: [...(await dispatchedInbox(dataDir)), ...cut], warnings: scan.warnings };
}

export async function deskInbox(employee: ClaimEmployee, dataDir: string, opts: CutScanOptions = {}): Promise<DeskItem[]> {
  if (employee === "writer") return writerInbox(dataDir);
  if (employee === "cover") return coverInbox(dataDir);
  return (await editorInbox(dataDir, opts)).items;
}

/** 测试注入 ChatCut 导出目录（`_chatcutExportDir`），和 `_dataDir` 一样不对外 */
export function cutOpts(params: Record<string, unknown>): CutScanOptions {
  return typeof params._chatcutExportDir === "string" ? { chatcutDir: params._chatcutExportDir } : {};
}

export async function executeDesk(params: Record<string, unknown>): Promise<DeskResult> {
  const dataDir = getDataDir((params._dataDir as string) || undefined);
  // 宿主身份由 MCP 层按命名 token 注入（§4.1）；没有它的调用一律记 local-user
  const host = str(params._host) || LOCAL_HOST;
  const action = str(params.action);
  const employee = params.employee;
  try {
    if (action === "inbox") {
      if (!isClaimEmployee(employee)) return fail("employee 必填：writer | cover | editor");
      if (employee === "editor") {
        const { items, warnings } = await editorInbox(dataDir, cutOpts(params));
        return { ok: true, employee, count: items.length, items, ...(warnings.length ? { warnings } : {}) };
      }
      const items = await deskInbox(employee, dataDir);
      return { ok: true, employee, count: items.length, items };
    }
    if (action === "claim") {
      const contentId = str(params.content_id);
      if (!contentId) return fail("content_id 必填");
      if (!isClaimEmployee(employee)) return fail("employee 必填：writer | cover | editor");
      const takeover = params.takeover === true;
      const result = await claimContent(contentId, employee, host, dataDir, {
        token: str(params.claim_token) || undefined,
        takeover,
        ...(takeover ? { founderConfirmed: await founderApprovesTakeover(contentId, host, dataDir) } : {}),
      });
      if (!result.ok) {
        return fail(result.error, { ...(result.code ? { code: result.code } : {}), ...(result.holder ? { holder: result.holder } : {}) });
      }
      return {
        ok: true,
        content_id: contentId,
        employee: result.claim.employee,
        host: result.claim.host,
        claim_token: result.claim.token,
        lease_until: result.claim.leaseUntil,
      };
    }
    if (action === "release") {
      const contentId = str(params.content_id);
      const token = str(params.claim_token);
      if (!contentId || !token) return fail("content_id 与 claim_token 必填");
      const result = await releaseClaim(contentId, token, dataDir);
      if (!result.ok) return fail(result.error, result.holder ? { holder: result.holder } : {});
      return { ok: true, content_id: contentId, released: result.released };
    }
    return fail(`未知 action：${action || "(空)"}。支持：${ACTIONS.join(" | ")}`);
  } catch (err) {
    return fail(`desk ${action || ""} 执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
