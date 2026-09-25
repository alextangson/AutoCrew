/**
 * `autocrew_video register`：Codex 剪辑工位把成片与封面登记回来（P6 spec §3.4）。Codex 唯一的写动作。
 *
 * 校验顺序照 spec 字面：**重放 → 交接 → 路径 → 产物**，过写门（P6 §3.8），然后四样同事务落盘（register-commit.ts）。
 * - 重放：`register_hash` 已是当前 final 或在 history 里 → 原样返回，不重写（Codex 超时重试、双击）。
 * - 交接：`manifest_hash` 必须是当前交接且没撤回，否则 `stale_handoff`——旧交接包的迟到登记进不来。
 * - 路径：项目目录仍在白名单里、归属仍是本稿；每个文件都在项目目录里、无符号链接。
 * - 产物：成片 / 封面的哈希必须等于人工审批凭据（gate3 / gate4），`user_message` 只照记。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, type Content } from "../../../storage/local-store.js";
import { stampVideoReady } from "../video-done.js";
import type { HandoffContext } from "./handoff.js";
import { serializeVideoLine } from "./lock.js";
import { registerHash, sha256File } from "./manifest.js";
import { recheckProjectRoot, resolveProjectFile } from "./paths.js";
import { stageArtifacts, type ArtifactPaths } from "./register-artifacts.js";
import { commitRegister, recoverRegisterJournal, registeredResult, type StampFn } from "./register-commit.js";
import { expandHome, usableRoots } from "./roots.js";
import { handoffFail, type HandoffResult, type RegisterApprovals, type VideoHandoffRecord } from "./types.js";

export interface RegisterInput {
  contentId: string;
  manifestHash: string;
  finalPath: string;
  covers: { "3:4": string; "4:3": string };
  srtPath?: string;
  jianyingDraft?: string;
  approvals: RegisterApprovals;
  host: string;
}

export interface RegisterContext extends HandoffContext {
  /** 成片戳（测试注入失败用；缺省 = 视频线共用的 `stampVideoReady`） */
  stamp?: StampFn;
}

const SHA_RE = /^[0-9a-f]{64}$/;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 中转端点会把对象参数序列化成 JSON 字符串（tool-args 那条实机教训）：两种形状都收 */
function objectArg(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function approvalOf(raw: unknown, which: string): RegisterApprovals["final_cut"] | string {
  const a = objectArg(raw);
  if (!a) return `approvals.${which} 缺失`;
  const sha = str(a.artifact_sha256).toLowerCase();
  if (!SHA_RE.test(sha)) return `approvals.${which}.artifact_sha256 必须是 64 位 sha256 hex`;
  const approvedAt = str(a.approved_at);
  if (!approvedAt || Number.isNaN(Date.parse(approvedAt))) return `approvals.${which}.approved_at 不是合法时间`;
  if (typeof a.user_message !== "string") return `approvals.${which}.user_message 必须是创作者批准时的原话（字符串）`;
  return { artifact_sha256: sha, approved_at: approvedAt, user_message: a.user_message };
}

/** 参数形状校验：失败回 `invalid_params`（人话说清缺哪一样） */
export function parseRegisterInput(params: Record<string, unknown>, contentId: string, host: string): RegisterInput | HandoffResult {
  const covers = objectArg(params.covers);
  const approvals = objectArg(params.approvals);
  const bad = (why: string) => handoffFail("invalid_params", `register 参数不全：${why}`);
  const manifestHash = str(params.manifest_hash).toLowerCase();
  if (!SHA_RE.test(manifestHash)) return bad("manifest_hash（交接包里的那个）");
  if (!str(params.final_path)) return bad("final_path");
  if (!covers || !str(covers["3:4"]) || !str(covers["4:3"])) return bad("covers 要同时给 \"3:4\" 与 \"4:3\" 两张");
  if (!approvals) return bad("approvals（gate3 final_cut 与 gate4 covers 两份凭据）");
  const finalCut = approvalOf(approvals.final_cut, "final_cut");
  if (typeof finalCut === "string") return bad(finalCut);
  const coverApproval = approvalOf(approvals.covers, "covers");
  if (typeof coverApproval === "string") return bad(coverApproval);
  return {
    contentId,
    manifestHash,
    finalPath: str(params.final_path),
    covers: { "3:4": str(covers["3:4"]), "4:3": str(covers["4:3"]) },
    ...(str(params.srt_path) ? { srtPath: str(params.srt_path) } : {}),
    ...(str(params.jianying_draft) ? { jianyingDraft: str(params.jianying_draft) } : {}),
    approvals: { final_cut: finalCut, covers: coverApproval },
    host,
  };
}

export function isRegisterInput(v: RegisterInput | HandoffResult): v is RegisterInput {
  return typeof (v as RegisterInput).manifestHash === "string";
}

/** 字幕哈希进登记指纹；读不了就给一个不会与任何成功登记相撞的记号（路径门随后会拒） */
async function srtSha(srtPath?: string): Promise<string | undefined> {
  if (!srtPath) return undefined;
  const file = path.resolve(expandHome(srtPath));
  return sha256File(file).catch(() => `unreadable:${file}`);
}

function replayOf(content: Content, hash: string): HandoffResult | null {
  const video = content.video;
  if (video?.final?.register_hash === hash) {
    return registeredResult(content.id, video.final, { replayed: true, content_status: content.status });
  }
  const old = video?.history?.find((h) => h.register_hash === hash);
  return old ? registeredResult(content.id, old, { replayed: true, superseded: true, content_status: content.status }) : null;
}

/** 交接门：清单必须是当前代次且没撤回；状态必须还在剪辑（或同代次重登记的待发布） */
function handoffBlock(content: Content, manifestHash: string): HandoffResult | null {
  const record = content.video?.handoff;
  const revoked = content.video?.revoked ?? [];
  if (!record || record.hash !== manifestHash || revoked.includes(manifestHash)) {
    const live = record && !revoked.includes(record.hash) ? record : undefined;
    return handoffFail("stale_handoff",
      live
        ? `这份交接包不是当前代次：当前是第 ${live.generation} 代（${live.project_handoff_path}），读新交接包再说`
        : "这份交接已撤回，当前没有有效交接：等 Claude 会话重新交接",
      { current_generation: live?.generation ?? null, expected_manifest_hash: live?.hash ?? null });
  }
  if (content.status !== "editing" && content.status !== "publish_ready") {
    return handoffFail("not_editing", `稿件现在是 ${content.status}，不在剪辑中，登记不收`);
  }
  return null;
}

type Resolved = { ok: true; value: ArtifactPaths & { srt?: string } } | { ok: false; result: HandoffResult };

async function resolveFiles(content: Content, record: VideoHandoffRecord, input: RegisterInput, dataDir: string): Promise<Resolved> {
  const roots = await usableRoots(dataDir);
  if (!roots.ok) return roots;
  const project = await recheckProjectRoot(record.project_root, roots.value, content.id);
  if (!project.ok) return project;
  const final = await resolveProjectFile(input.finalPath, record.project_root, "final_path");
  if (!final.ok) return final;
  const cover34 = await resolveProjectFile(input.covers["3:4"], record.project_root, "covers.3:4");
  if (!cover34.ok) return cover34;
  const cover43 = await resolveProjectFile(input.covers["4:3"], record.project_root, "covers.4:3");
  if (!cover43.ok) return cover43;
  const srt = input.srtPath ? await resolveProjectFile(input.srtPath, record.project_root, "srt_path") : undefined;
  if (srt && !srt.ok) return srt;
  return { ok: true, value: { final: final.value, cover34: cover34.value, cover43: cover43.value, ...(srt ? { srt: srt.value } : {}) } };
}

export async function registerVideo(input: RegisterInput, ctx: RegisterContext): Promise<HandoffResult> {
  return serializeVideoLine(input.contentId, () => registerLocked(input, ctx));
}

async function registerLocked(input: RegisterInput, ctx: RegisterContext): Promise<HandoffResult> {
  await recoverRegisterJournal(input.contentId, ctx.dataDir);
  const content = await getContent(input.contentId, ctx.dataDir);
  if (!content) return handoffFail("invalid_params", `稿件不存在：${input.contentId}`);
  const hash = registerHash({
    manifestHash: input.manifestHash,
    finalSha: input.approvals.final_cut.artifact_sha256,
    coversSha: input.approvals.covers.artifact_sha256,
    srtSha: await srtSha(input.srtPath),
  });
  const replay = replayOf(content, hash);
  if (replay) return replay;

  const blocked = handoffBlock(content, input.manifestHash);
  if (blocked) return blocked;
  const record = content.video!.handoff!;
  const files = await resolveFiles(content, record, input, ctx.dataDir);
  if (!files.ok) return files.result;
  const staged = await stageArtifacts(content.id, ctx.dataDir, files.value, input.approvals);
  if (!staged.ok) return staged.result;
  try {
    // 写门在核验之后、四样落盘之前：核验失败不留认领副作用，重试时交接包里的令牌照样有效
    const gate = await ctx.gate();
    if ("denied" in gate) return gate.denied;
    const result = await commitRegister({
      content, record, staged: staged.value, files: files.value, jianyingDraft: input.jianyingDraft,
      approvals: input.approvals, registerHash: hash, host: input.host, dataDir: ctx.dataDir,
      stamp: ctx.stamp ?? stampVideoReady,
    });
    return result.ok ? result : { ...result, ...gate.grant };
  } finally {
    await fs.rm(staged.value.dir, { recursive: true, force: true });
  }
}
