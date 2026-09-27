import { assertManagedPathAvailable } from "../../../storage/storage-roots.js";
import { contentFile } from "../../../storage/content-project.js";
/**
 * 登记的四样落盘（P6 spec §3.4 register 第 5 步）：(a) 成片素材 (b) 封面评审单 (c) 成片戳
 * (d) 状态 + `video.final`。**任一失败，全部回滚，状态不推进。**
 *
 * 四样分属三个文件（meta.json / cover-review.json / assets 下的拷贝），做不成真事务，
 * 所以用日志兜底：动手前先把「改之前」的快照写进 `handoff/register-journal.json`，
 * 失败时按快照逐样还原；进程中途崩掉，下一次 register 进门先看日志——
 * 状态已是 publish_ready 且 `final.register_hash` 对得上 = 已提交，删日志；否则按快照回滚。
 *
 * (d) 是提交点：状态与 `video.final` 同一次写（`transitionStatus` 的 patch），
 * 阶段门在写锁里核 (b)(c) 两样都在（`editing → publish_ready` 只在成片戳 + 封面定稿时放行）。
 * 已知不还原的：封面定稿顺手复制到稿件根目录的「封面*.png」便携副本（下一次定稿会覆盖）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "../../../storage/json-atomic.js";
import {
  approveCoverVariant,
  contentDir,
  getContent,
  saveCoverReview,
  transitionStatus,
  updateContent,
  upsertAsset,
  type Asset,
  type Content,
  type ContentClaim,
  type ContentHandoff,
  type CoverVariant,
} from "../../../storage/local-store.js";
import type { VideoStamp } from "../video-done.js";
import type { StagedArtifacts } from "./register-artifacts.js";
import {
  handoffFail,
  type ContentVideoLink,
  type HandoffResult,
  type RegisterApprovals,
  type VideoFinalRecord,
  type VideoHandoffRecord,
} from "./types.js";

export type StampFn = (contentId: string, renderedRevision: number, dataDir: string) => Promise<VideoStamp>;

export interface RegisterJournal {
  register_hash: string;
  started_at: string;
  /** 这次登记新建的文件（回滚删掉；原本就在的不动） */
  created: string[];
  prev: {
    coverReviewRaw: string | null;
    videoDone?: Content["videoDone"];
    videoReadyAt?: string;
    assets: Asset[];
    video?: ContentVideoLink;
    claim?: ContentClaim;
    handoffs?: ContentHandoff[];
  };
}

export interface CommitArgs {
  content: Content;
  record: VideoHandoffRecord;
  staged: StagedArtifacts;
  files: { final: string; cover34: string; cover43: string; srt?: string };
  jianyingDraft?: string;
  approvals: RegisterApprovals;
  registerHash: string;
  host: string;
  dataDir: string;
  stamp: StampFn;
}

interface Destinations {
  finalName: string;
  finalDest: string;
  cover34: string;
  cover43: string;
}

export function registeredResult(contentId: string, final: VideoFinalRecord, extra: Record<string, unknown> = {}): HandoffResult {
  return {
    ok: true,
    status: "registered",
    content_id: contentId,
    generation: final.generation,
    register_hash: final.register_hash,
    video_ready_at: final.video_ready_at,
    next_action: {
      tool: "autocrew_pre_publish",
      params: { action: "video_kit", content_id: contentId },
      message: "成片与封面已登记、稿件进入待发布：下一步在 Claude 会话里写视频发布包（video_kit），发布仍由人点。",
    },
    ...extra,
  };
}

function journalPath(contentId: string, dataDir: string): string {
  return contentFile(contentId, dataDir, "handoff", "register-journal.json");
}

function coverReviewPath(contentId: string, dataDir: string): string {
  return contentFile(contentId, dataDir, "cover-review.json");
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

/** 文件名里的内容指纹长度：16 位 hex = 64 bit，同名即同字节 */
const NAME_SHA_CHARS = 16;

function destinations(a: CommitArgs): Destinations {
  // 原地登记：登记的就是项目里那几份文件本身
  if (a.staged.dir === null) return { finalName: path.basename(a.files.final), finalDest: a.files.final, cover34: a.files.cover34, cover43: a.files.cover43 };
  const gen = a.record.generation;
  const finalName = `final-g${gen}-${a.staged.final.sha.slice(0, NAME_SHA_CHARS)}${a.staged.final.ext}`;
  const cover = (ratio: "3:4" | "4:3") => {
    const c = a.staged.covers[ratio];
    return contentFile(a.content.id, a.dataDir, "assets", "covers", `codex-g${gen}-${c.sha.slice(0, NAME_SHA_CHARS)}-${ratio.replace(":", "x")}${c.ext}`);
  };
  return { finalName, finalDest: contentFile(a.content.id, a.dataDir, "assets", finalName), cover34: cover("3:4"), cover43: cover("4:3") };
}

/** 动手前的快照；日志先落盘，之后任何一步崩掉都找得回「改之前」 */
async function openJournal(a: CommitArgs, dests: Destinations): Promise<RegisterJournal> {
  const current = (await getContent(a.content.id, a.dataDir)) ?? a.content;
  const created: string[] = [];
  // 原地登记不新建文件：回滚绝不能删项目里的成片和封面
  for (const file of a.staged.dir === null ? [] : [dests.finalDest, dests.cover34, dests.cover43]) {
    if (!(await exists(file))) created.push(file);
  }
  const journal: RegisterJournal = {
    register_hash: a.registerHash,
    started_at: new Date().toISOString(),
    created,
    prev: {
      coverReviewRaw: await readOrNull(coverReviewPath(a.content.id, a.dataDir)),
      videoDone: current.videoDone,
      videoReadyAt: current.videoReadyAt,
      assets: current.assets ?? [],
      video: current.video,
      claim: current.claim,
      handoffs: current.handoffs,
    },
  };
  await fs.mkdir(path.dirname(journalPath(a.content.id, a.dataDir)), { recursive: true });
  await writeJsonAtomic(journalPath(a.content.id, a.dataDir), journal);
  return journal;
}

/** 按快照逐样还原；还原本身失败就留着日志，下一次 register 进门再试 */
export async function rollbackJournal(contentId: string, journal: RegisterJournal, dataDir: string): Promise<void> {
  const reviewPath = coverReviewPath(contentId, dataDir);
  if (journal.prev.coverReviewRaw === null) await fs.rm(reviewPath, { force: true });
  else await writeTextAtomic(reviewPath, journal.prev.coverReviewRaw);
  const { videoDone, videoReadyAt, assets, video, claim, handoffs } = journal.prev;
  await updateContent(contentId, { videoDone, videoReadyAt, assets, video, claim, handoffs }, dataDir);
  for (const file of journal.created) await fs.rm(file, { force: true }).catch(() => undefined);
  await fs.rm(journalPath(contentId, dataDir), { force: true });
}

/** 进门先看有没有上一次崩在半路的登记 */
export async function recoverRegisterJournal(contentId: string, dataDir: string): Promise<void> {
  const raw = await readOrNull(journalPath(contentId, dataDir));
  if (raw === null) return;
  const journal = JSON.parse(raw) as RegisterJournal;
  const content = await getContent(contentId, dataDir);
  const committed = content?.status === "publish_ready" && content.video?.final?.register_hash === journal.register_hash;
  if (committed) await fs.rm(journalPath(contentId, dataDir), { force: true });
  else await rollbackJournal(contentId, journal, dataDir);
}

async function placeFiles(staged: StagedArtifacts, dests: Destinations): Promise<void> {
  if (staged.dir === null) return;
  await fs.mkdir(path.dirname(dests.cover34), { recursive: true });
  await fs.mkdir(path.dirname(dests.finalDest), { recursive: true });
  // 文件名带内容哈希前缀：已存在 = 同一份字节（重登记同一版成片），不必再搬
  const moves: Array<[string, string]> = [
    [staged.final.tmp, dests.finalDest],
    [staged.covers["3:4"].tmp, dests.cover34],
    [staged.covers["4:3"].tmp, dests.cover43],
  ];
  for (const [from, to] of moves) {
    assertManagedPathAvailable(to);
    if (!(await exists(to))) await fs.rename(from, to);
  }
}

/** (a) 成片进稿件素材：ego-lite 读 `assets/<filename>`；role=other 防止被当成 A-roll 候选 */
async function registerAsset(a: CommitArgs, dests: Destinations): Promise<void> {
  const gen = a.record.generation;
  const up = await upsertAsset(a.content.id, {
    filename: dests.finalName,
    ...(a.staged.dir === null ? { projectPath: path.relative(a.record.project_root, a.files.final) } : {}),
    type: "video",
    role: "other",
    renderedRevision: gen,
    description: `Codex 剪辑成片 g${gen}`,
    media: { durationMs: a.staged.final.durationMs },
  }, a.dataDir);
  if (!up.ok) throw new Error(`成片素材登记失败：${up.error ?? "未知原因"}`);
}

/** (b) 封面评审单：一个 draftPair 变体，走与人工定稿同一个 approve（配对哈希在那里再核一遍） */
async function registerCovers(a: CommitArgs, dests: Destinations): Promise<void> {
  const gen = a.record.generation;
  const variant: CoverVariant = {
    label: "codex",
    imagePaths: { "3:4": dests.cover34, "4:3": dests.cover43 },
    draftPair: {
      sourceSha256: a.staged.covers["3:4"].sha,
      derivedSha256: a.staged.covers["4:3"].sha,
      sourceRevision: 1,
      model: "codex",
      generatedAt: new Date().toISOString(),
    },
    model: "codex",
    designReason: `Codex 剪辑工位 gate4 批准的配对封面（第 ${gen} 代交接）`,
  };
  const review = { platform: a.content.platform ?? "", status: "review_pending" as const, primaryRatio: "3:4" as const, variants: [variant], notes: `register g${gen}` };
  if (!(await saveCoverReview(a.content.id, review, a.dataDir))) throw new Error("封面评审单没写进去");
  if (!(await approveCoverVariant(a.content.id, "codex", a.dataDir))) throw new Error("封面定稿没过（两张图与配对哈希对不上）");
}

function withFinal(video: ContentVideoLink | undefined, final: VideoFinalRecord): ContentVideoLink {
  const history = video?.final ? [...(video.history ?? []), video.final] : video?.history ?? [];
  return { ...video, final, history };
}

/** (d) 提交点：状态与 video.final 同一次写；已是待发布（同代次换封面重登记）就只写记录 */
async function landFinal(a: CommitArgs, dests: Destinations, videoReadyAt: string | null): Promise<VideoFinalRecord> {
  const final: VideoFinalRecord = {
    path: a.files.final,
    asset_filename: dests.finalName,
    sha256: a.staged.final.sha,
    duration_ms: a.staged.final.durationMs,
    covers: { "3:4": a.files.cover34, "4:3": a.files.cover43 },
    cover_copies: { "3:4": dests.cover34, "4:3": dests.cover43 },
    ...(a.files.srt ? { srt_path: a.files.srt } : {}),
    ...(a.jianyingDraft ? { jianying_draft: a.jianyingDraft } : {}),
    approvals: a.approvals,
    registered_by: a.host,
    at: new Date().toISOString(),
    generation: a.record.generation,
    manifest_hash: a.record.hash,
    register_hash: a.registerHash,
    video_ready_at: videoReadyAt,
  };
  // 登记是剪辑工位最后一个写动作：认领随之释放，Claude 会话下一步（发布包）自动认领
  const patch = (current: Content) => ({ video: withFinal(current.video, final), claim: undefined });
  if (a.content.status === "editing") {
    const moved = await transitionStatus(a.content.id, "publish_ready", { expectedStatus: "editing", host: a.host, patch }, a.dataDir);
    if (!moved.ok) throw new Error(`状态推不到待发布：${moved.error ?? "未知原因"}`);
  } else {
    const current = await getContent(a.content.id, a.dataDir);
    if (!current || current.status !== a.content.status) throw new Error("稿件状态在登记途中变了");
    await updateContent(a.content.id, patch(current), a.dataDir);
  }
  return final;
}

export async function commitRegister(a: CommitArgs): Promise<HandoffResult> {
  const dests = destinations(a);
  const journal = await openJournal(a, dests);
  try {
    await placeFiles(a.staged, dests);
    await registerAsset(a, dests);
    await registerCovers(a, dests);
    const stamp = await a.stamp(a.content.id, a.record.generation, a.dataDir);
    if (stamp.stampWarning) throw new Error(stamp.stampWarning);
    const final = await landFinal(a, dests, stamp.videoReadyAt);
    await fs.rm(journalPath(a.content.id, a.dataDir), { force: true }).catch(() => undefined);
    return registeredResult(a.content.id, final, { content_status: "publish_ready" });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if ((err as { code?: string }).code === "PROJECT_COMMIT_UNCERTAIN") {
      return handoffFail("register_failed", `登记结果待恢复：${why}；日志已保留，下一次 register 会先核验提交结果，不重复登记。`);
    }
    try {
      await rollbackJournal(a.content.id, journal, a.dataDir);
    } catch (undo) {
      const undoWhy = undo instanceof Error ? undo.message : String(undo);
      return handoffFail("register_failed", `登记没落盘：${why}；回滚也失败了（${undoWhy}），下一次 register 会先按日志回滚`);
    }
    return handoffFail("register_failed", `登记没落盘，已全部回滚、状态未推进：${why}`);
  }
}
