/**
 * 发包（P3 spec §5.1，2026-09-06 实机验收后改成异步）——`pack` 与 `pack_status` 的实现。
 *
 * 为什么不能同步发包：备料（材料收集 + 定向补证）要跑**几分钟**，而 MCP 宿主把工具调用
 * 卡在 60 秒（TS SDK 默认值；Codex 是 `tool_timeout_sec`）。实机上发生的事是：客户端超时
 * 放弃 → 服务端照跑不误 → 几分钟后用一个**新 pack_id** 覆盖了 `writing-pack.json` →
 * 宿主后来的 submit 全部打在另一个包上，而且没有任何一方报错。所以这一版把发包切成两段：
 *
 *   `pack` 立刻回 `{status:"preparing", content_id, pack_id}`（只跑立意闸口 + 建占位稿 + 领号）
 *   后台备料 →（成功）整份包原子落盘 `state:"ready"` ／（失败）`state:"failed"` + 人话原因
 *   `pack_status` 轮询，ready 之后回的就是老版同步 `pack` 的那份完整回执
 *
 * 两条纪律让它不再互相覆盖：
 * - **同一篇稿同时只有一次备料**：模块级 `preparing` 表按 content_id 挡重入，
 *   `pack` 再来一次拿到的是**同一个** pack_id，绝不起第二条后台任务；
 * - **落盘前认号**：后台任务写回之前先读盘对 `packId`，号被 `force` 换掉了就把自己的结果丢掉。
 *   这正是实机那条 bug 的堵口——迟到的备料不许覆盖现行的包。
 */
import { writeTextAtomic } from "../storage/json-atomic.js";
import { getTopic, listContents, updateContent, type Content } from "../storage/local-store.js";
import { CLIPBOARD_PLATFORMS, type ClipboardPlatform } from "../modules/publish/clipboard-publisher.js";
import {
  buildWritingContext,
  contentAttributionOf,
  createPlaceholder,
  type ScriptRequest,
  type WritingContext,
} from "../modules/writing/generate-script.js";
import { DEFAULT_REPAIR_ROUNDS } from "../modules/writing/script-payload.js";
import { rulesForPlatform } from "../modules/profile/creator-profile.js";
import { cleanErrorMessage } from "../desktop/error-clean.js";
import type { runLoop } from "../engine/loop.js";
import { angleGate } from "./workflow.js";
import { describeWriterFailure } from "./writer-failure.js";
import {
  isReadyPack,
  packBudget,
  packPath,
  readPack,
  renderPack,
  serializeWriterCall,
  writePack,
  PACK_MD,
  type PackState,
  type ReadyPack,
  type WritingPackFile,
} from "./writer-pack.js";

export interface PackDeps {
  /** 测试注入（默认 listContents）：复用判定要读全量稿件 */
  listContentsImpl?: () => Promise<Content[]>;
  /** 测试注入的 loop 替身：定向补证在备料里跑，生产不传 */
  runLoopImpl?: typeof runLoop;
  /** 测试注入的备料替身：让「还在准备中」这个中间态可被确定地观测，生产不传 */
  buildContextImpl?: typeof buildWritingContext;
  onWarn?: (message: string) => void;
}

type Fail = { ok: false; error: string } & Record<string, unknown>;

/** 领号回执（备料还在跑） */
export interface PackPreparingResult extends Record<string, unknown> {
  ok: true;
  status: "preparing";
  content_id: string;
  pack_id: string;
  note: string;
}

/** 备料完成的完整回执——**与改异步之前那份同步 `pack` 的返回体逐字段相同** */
export interface PackReadyResult extends Record<string, unknown> {
  ok: true;
  status: "ready";
  content_id: string;
  pack_id: string;
  pack_md: string;
  budget: { find_evidence_left: number; repair_rounds_left: number };
  note: string;
}

const POLL_NOTE = "备料通常 1–6 分钟：用 pack_status{content_id} 轮询，status=ready 之后再动笔。";
const FIRST_NOTE = "写完用 submit 交回来；数字要能指到证据编号，缺证据先 find_evidence。";
const REISSUE_NOTE = "这条选题上原来那份包已作废（同一篇稿换了新 pack_id），旧包的提交会被拒。";

/**
 * 在跑的备料：key 是 content_id，值是**不会 reject** 的后台任务。
 * 它同时是「别起第二条」的锁与测试的等待点（`packPreparation`）。
 */
const preparing = new Map<string, Promise<void>>();

/** 测试与桌面端等一次备料落地用（生产链路一律轮询 `pack_status`，不 await 它） */
export function packPreparation(contentId: string): Promise<void> | undefined {
  return preparing.get(contentId);
}

function newPackId(): string {
  return `wp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function elapsedSeconds(iso: string): number {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

function readyResult(contentId: string, pack: ReadyPack): PackReadyResult {
  return {
    ok: true,
    status: "ready",
    content_id: contentId,
    pack_id: pack.packId,
    pack_md: renderPack(contentId, pack),
    budget: packBudget(pack),
    note: pack.note ?? FIRST_NOTE,
  };
}

// ─── pack ─────────────────────────────────────────────────────────────────────

/**
 * 复用哪一篇稿：同一选题上**还没交稿**的占位稿原地续用（§5.2），
 * 不新建第二张卡——领两次包留两张僵尸卡正是重试链的老毛病。
 */
async function reusablePlaceholder(
  topicId: string,
  platform: string,
  listContentsImpl: () => Promise<Content[]>,
): Promise<Content | null> {
  const all = await listContentsImpl();
  const hit = all.find(
    (c) =>
      c.topicId === topicId &&
      c.platform === platform &&
      c.status === "drafting" &&
      Boolean(c.pack) &&
      !c.pack?.submittedAt,
  );
  return hit ?? null;
}

export interface PackParams {
  topicId: string;
  platform: string;
  direction: string;
  skipReason: string;
  host: string;
  /** 作废手上这份包、重跑一次备料（宿主明说要重来时才给 true） */
  force: boolean;
}

export async function startPack(
  params: PackParams,
  dataDir: string,
  deps: PackDeps,
): Promise<PackPreparingResult | PackReadyResult | Fail> {
  const warn = deps.onWarn ?? ((m: string) => console.warn(`[writer] ${m}`));
  if (!(CLIPBOARD_PLATFORMS as readonly string[]).includes(params.platform)) {
    return { ok: false, error: `无效 platform「${params.platform}」。有效值：${CLIPBOARD_PLATFORMS.join(" | ")}` };
  }
  const topic = await getTopic(params.topicId, dataDir);
  if (!topic) return { ok: false, error: `选题不存在：${params.topicId}` };

  const req: ScriptRequest = {
    topic: topic.title,
    platform: params.platform as ClipboardPlatform,
    topicId: params.topicId,
    ...(params.direction ? { direction: params.direction } : {}),
    ...(params.skipReason ? { angleSkipReason: params.skipReason } : {}),
  };
  // 立意闸口与内部写作同一份（§5.1）：有候选卡却没选，宿主也得回去问创始人。
  // 它必须留在同步段——这是拒单，不是「先答应下来再后台失败」。
  const gated = await angleGate(params.topicId, req, dataDir, warn);
  if (gated) return gated as Fail;

  const existing = await reusablePlaceholder(
    params.topicId,
    params.platform,
    deps.listContentsImpl ?? (() => listContents(dataDir)),
  );
  const contentId = existing?.id ?? (await createPlaceholder(req, dataDir));
  const inFlight = preparing.has(contentId);
  const current = await readPack(contentId, dataDir);

  if (!params.force) {
    // 已经备好了就原样还给他（不重跑：备料花的是真钱）
    if (isReadyPack(current)) return readyResult(contentId, current);
    // 还在跑：同一个号回第二遍，绝不起第二条后台任务
    if (current?.state === "preparing" && inFlight) {
      return { ok: true, status: "preparing", content_id: contentId, pack_id: current.packId, note: POLL_NOTE };
    }
  }
  // 落到这里的三种情形都该重跑：force、没有包、以及「盘上写着 preparing 但没有任务在跑」
  // （进程重启留下的孤儿，不重跑它就永远 ready 不了）。
  return startPreparation({ contentId, req, host: params.host, reissued: Boolean(current) }, dataDir, deps);
}

async function startPreparation(
  args: { contentId: string; req: ScriptRequest; host: string; reissued: boolean },
  dataDir: string,
  deps: PackDeps,
): Promise<PackPreparingResult> {
  const { contentId, host } = args;
  const packId = newPackId();
  const issuedAt = new Date().toISOString();
  const note = args.reissued ? REISSUE_NOTE : FIRST_NOTE;
  const placeholder: WritingPackFile = {
    packId,
    issuedAt,
    state: "preparing",
    note,
    host,
    briefHash: "",
    angleId: "",
    ledger: { entries: [], lookups: [], budget: { max: 0, used: 0 } },
    ledgerBudget: { max: 0, used: 0 },
    repair: { max: DEFAULT_REPAIR_ROUNDS, used: 0 },
    reviewRounds: 0,
    attempts: {},
  };
  // 先落号再开工：宿主拿到的 pack_id 从这一刻起就是这篇稿的 fencing token。
  // 落号要排队——插在一次补证的读-改-写中间，等于把作废的旧包又写回去（见 `serializeWriterCall`）
  await serializeWriterCall(contentId, async () => {
    await writePack(contentId, placeholder, dataDir);
    await updateContent(
      contentId,
      {
        writtenBy: { kind: "host", host },
        pack: { packId, issuedAt, host },
        lastError: null,
        _versionNote: args.reissued ? `重新发写作包给 ${host}（旧包作废）` : `写作包发给 ${host}`,
      },
      dataDir,
    );
  });

  const work = prepare({ contentId, packId, req: args.req, host, note }, dataDir, deps);
  const task: Promise<void> = work.finally(() => {
    if (preparing.get(contentId) === task) preparing.delete(contentId);
  });
  preparing.set(contentId, task);
  return {
    ok: true,
    status: "preparing",
    content_id: contentId,
    pack_id: packId,
    note: args.reissued ? `${REISSUE_NOTE}${POLL_NOTE}` : POLL_NOTE,
  };
}

// ─── 后台备料 ─────────────────────────────────────────────────────────────────

interface PrepareArgs {
  contentId: string;
  packId: string;
  req: ScriptRequest;
  host: string;
  note: string;
}

/** 后台任务**永不 reject**：失败也是一个要落盘的状态，不是掉在地上的 rejection */
async function prepare(args: PrepareArgs, dataDir: string, deps: PackDeps): Promise<void> {
  const warn = deps.onWarn ?? ((m: string) => console.warn(`[writer] ${m}`));
  try {
    const build = deps.buildContextImpl ?? buildWritingContext;
    // 材料收集 + 定向补证（各自的墙钟在里面）+ 提示词装配——与内部写手**同一个函数**
    const built = await build(args.req, dataDir, warn, deps.runLoopImpl ? { runLoopImpl: deps.runLoopImpl } : undefined);
    await finishReady(args, built, dataDir);
  } catch (err) {
    await finishFailed(args, err, dataDir).catch((e) => warn(`写作包失败状态没写回：${cleanErrorMessage(e)}`));
  }
}

/**
 * 号还是我的吗？`force` 重发之后旧任务的结果**必须丢掉**——
 * 覆盖现行的包正是这次要修的那条实机 bug。
 */
async function stillMine(contentId: string, packId: string, dataDir: string): Promise<WritingPackFile | null> {
  const current = await readPack(contentId, dataDir);
  return current?.packId === packId ? current : null;
}

function readyPackOf(args: PrepareArgs, base: WritingPackFile, built: WritingContext): ReadyPack {
  const { inputs, prompts, gate } = built;
  const snapshot = inputs.ledger.snapshot();
  const platform = args.req.platform;
  return {
    ...base,
    state: "ready",
    note: args.note,
    briefHash: inputs.attribution.usedBriefHash ?? "",
    angleId: inputs.attribution.usedAngle?.id ?? "",
    ledger: snapshot,
    ledgerBudget: { max: snapshot.budget.max, used: snapshot.budget.used },
    // 修复轮上限与内部写手同源：包有 gate 就用它的，没有 gate 也照给缺省（抖音包没 gate，但硬门照拦）
    repair: { max: gate?.maxRepairRounds ?? DEFAULT_REPAIR_ROUNDS, used: base.repair.used },
    context: {
      req: args.req,
      platform,
      trackPackId: inputs.pack.id,
      prompts,
      researchSlot: inputs.snapshot.text,
      ...(inputs.angle ? { angleCard: inputs.angle.card } : {}),
      voiceSamples: inputs.profile?.voiceSamples ?? [],
      canFindEvidence: Boolean(inputs.researcher),
      rulesApplied: inputs.profile ? rulesForPlatform(inputs.profile, platform).length : 0,
      wroteWithoutBrief: !inputs.attribution.usedBriefHash,
      wroteWithoutAngle: inputs.wroteWithoutAngle,
      ...(inputs.evidenceNote ? { evidenceNote: inputs.evidenceNote } : {}),
    },
  };
}

/** 认号 + 写回是一个不可分的动作，所以整段进队列（同 `find_evidence` 那条队） */
function finishReady(args: PrepareArgs, built: WritingContext, dataDir: string): Promise<void> {
  return serializeWriterCall(args.contentId, async () => {
    const base = await stillMine(args.contentId, args.packId, dataDir);
    if (!base) return;
    const pack = readyPackOf(args, base, built);
    await writePack(args.contentId, pack, dataDir);
    await writeTextAtomic(packPath(args.contentId, dataDir, PACK_MD), renderPack(args.contentId, pack));
    // 归因（账本、简报版本、角度、语料）在备料落地这一刻就进稿件：补证已经花过钱了，
    // 宿主一直不交稿也要查得到「这稿当时手上有哪些证据」
    await updateContent(
      args.contentId,
      {
        ...contentAttributionOf(built.inputs),
        lastError: null,
        _versionNote: `写作包备料完成（${args.host}）`,
      },
      dataDir,
    );
  });
}

async function finishFailed(args: PrepareArgs, err: unknown, dataDir: string): Promise<void> {
  const reason = await describeWriterFailure(err, "scout", dataDir, cleanErrorMessage(err));
  await serializeWriterCall(args.contentId, async () => {
    const base = await stillMine(args.contentId, args.packId, dataDir);
    if (!base) return;
    await writePack(args.contentId, { ...base, state: "failed", error: reason }, dataDir);
    // 稿件上也留一句：没有这一句，创始人在工作台只看到一张不动的「写作中」卡
    await updateContent(args.contentId, { lastError: `写作包准备失败：${reason}` }, dataDir);
  });
}

// ─── pack_status ──────────────────────────────────────────────────────────────

export interface PackStatusResult extends Record<string, unknown> {
  ok: true;
  status: PackState;
  pack_id: string;
  started_at: string;
  elapsed_s: number;
}

/**
 * 轮询口。`ready` 时回的**就是**备料完成的那份完整回执（宿主不必再 pack 一次）；
 * `failed` 仍然 `ok:true`——查状态这件事成功了，坏消息在 `status` 与 `error` 里，
 * 而且 submit/find_evidence 那头还有一道硬拦，漏看不会写出一篇没材料的稿。
 */
export async function packStatus(contentId: string, dataDir: string): Promise<PackStatusResult | Fail> {
  const pack = await readPack(contentId, dataDir);
  if (!pack) return { ok: false, error: `这篇没有写作包（${contentId}）——先 pack 一次` };
  const base = {
    ok: true as const,
    status: pack.state,
    pack_id: pack.packId,
    started_at: pack.issuedAt,
    elapsed_s: elapsedSeconds(pack.issuedAt),
  };
  if (isReadyPack(pack)) return { ...base, ...readyResult(contentId, pack), status: "ready" as const };
  if (pack.state === "failed") {
    return {
      ...base,
      error: pack.error ?? "未记原因",
      note: "这份包没备成，别动笔——pack{force:true} 重来一次；连着失败就先跑 autocrew_workflow doctor 看线路。",
    };
  }
  return { ...base, note: POLL_NOTE };
}
