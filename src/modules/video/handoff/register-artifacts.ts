/**
 * 登记的产物核验（P6 spec §3.4 register 第 4 步；codex 评审 #5）：**核的就是要登记的那份字节**。
 *
 * 先把成片与两张封面拷进稿件目录下的暂存区（APFS 上是写时复制克隆，GB 级成片也是瞬间），
 * 再对拷贝做 ffprobe / 魔数 / sha256，和人工审批凭据比对。比的若是 Codex 项目里的原文件，
 * 比完到拷贝之间原文件被重导出一次，登记进去的就是一份没人批过的片子。
 *
 * 不匹配时**不回报实际哈希**：凭据必须来自 gate 记录，回报实际值等于教宿主抄一个过门。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentDir } from "../../../storage/local-store.js";
import { probeMedia } from "../ingest.js";
import { coverPairHash, sha256File } from "./manifest.js";
import { handoffFail, type HandoffResult, type RegisterApproval, type RegisterApprovals } from "./types.js";

export interface StagedFile {
  tmp: string;
  sha: string;
  ext: string;
}

export interface StagedArtifacts {
  dir: string;
  final: StagedFile & { durationMs: number };
  covers: { "3:4": StagedFile; "4:3": StagedFile };
  coversSha: string;
}

export interface ArtifactPaths {
  final: string;
  cover34: string;
  cover43: string;
}

type Staged<T> = { ok: true; value: T } | { ok: false; result: HandoffResult };

/** 写时复制优先（APFS 克隆），文件系统不支持时退回普通拷贝 */
async function cloneCopy(src: string, dest: string): Promise<void> {
  await fs.copyFile(src, dest, fs.constants.COPYFILE_FICLONE);
}

async function stageFinal(src: string, dir: string, approval: RegisterApproval): Promise<Staged<StagedArtifacts["final"]>> {
  const ext = path.extname(src).toLowerCase() || ".mp4";
  const tmp = path.join(dir, `final${ext}`);
  await cloneCopy(src, tmp);
  const probed = await probeMedia(tmp);
  const invalid = (why: string): Staged<never> => ({ ok: false, result: handoffFail("final_invalid", `成片不合格：${why}`) });
  if (!probed.ok) return invalid(probed.reason);
  if (!probed.probe.video) return invalid("没有画面轨");
  if (!probed.probe.audio) return invalid("没有音轨");
  if (probed.probe.durationMs <= 0) return invalid("读不出时长，容器可能已损坏");
  const sha = await sha256File(tmp);
  if (sha !== approval.artifact_sha256) {
    return {
      ok: false,
      result: handoffFail("approval_mismatch",
        "成片文件的 sha256 与 gate3 批准凭据不符——被批准的不是这个文件。登记被批准的那一版，或重新走 gate3",
        { which: "final_cut" }),
    };
  }
  return { ok: true, value: { tmp, sha, ext, durationMs: probed.probe.durationMs } };
}

/** 按魔数认图：PNG `89 50 4E 47 0D 0A 1A 0A`，JPEG `FF D8 FF`；扩展名不作数 */
async function imageExt(file: string): Promise<".png" | ".jpg" | null> {
  const fh = await fs.open(file, "r");
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await fh.read(head, 0, 8, 0);
    const b = head.subarray(0, bytesRead);
    if (b.length >= 8 && b.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
    return null;
  } finally {
    await fh.close();
  }
}

async function stageCover(src: string, dir: string, ratio: "3:4" | "4:3"): Promise<Staged<StagedFile>> {
  const tmp = path.join(dir, `cover-${ratio.replace(":", "x")}`);
  await cloneCopy(src, tmp);
  const ext = await imageExt(tmp);
  if (!ext) {
    return { ok: false, result: handoffFail("cover_invalid", `${ratio} 封面不是 PNG / JPEG：${src}`, { which: ratio }) };
  }
  return { ok: true, value: { tmp, sha: await sha256File(tmp), ext } };
}

async function stageCovers(paths: ArtifactPaths, dir: string, approval: RegisterApproval): Promise<Staged<Pick<StagedArtifacts, "covers" | "coversSha">>> {
  const c34 = await stageCover(paths.cover34, dir, "3:4");
  if (!c34.ok) return c34;
  const c43 = await stageCover(paths.cover43, dir, "4:3");
  if (!c43.ok) return c43;
  const coversSha = coverPairHash(c34.value.sha, c43.value.sha);
  if (coversSha !== approval.artifact_sha256) {
    return {
      ok: false,
      result: handoffFail("approval_mismatch",
        "两张封面的配对哈希与 gate4 批准凭据不符——批准的不是这一对。算法：sha256(3:4 的 sha256 hex + 4:3 的 sha256 hex)",
        { which: "covers" }),
    };
  }
  return { ok: true, value: { covers: { "3:4": c34.value, "4:3": c43.value }, coversSha } };
}

/** 暂存 + 核验；失败时暂存区已清掉。成功时由调用方在收尾后删 `dir` */
export async function stageArtifacts(
  contentId: string,
  dataDir: string,
  paths: ArtifactPaths,
  approvals: RegisterApprovals,
): Promise<Staged<StagedArtifacts>> {
  const dir = path.join(contentDir(contentId, dataDir), "assets", `.register-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    const final = await stageFinal(paths.final, dir, approvals.final_cut);
    const covers = final.ok ? await stageCovers(paths, dir, approvals.covers) : final;
    if (!final.ok || !covers.ok) {
      await fs.rm(dir, { recursive: true, force: true });
      return !final.ok ? final : (covers as { ok: false; result: HandoffResult });
    }
    return { ok: true, value: { dir, final: final.value, ...covers.value } };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}
