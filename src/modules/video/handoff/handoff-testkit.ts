/**
 * 交接—登记线的测试夹具（**只被 *.test.ts 引用**）。
 *
 * 全部落在临时目录：数据目录、白名单根、「白名单外」目录各一个，`video.json` 指向临时根——
 * 绝不碰 `~/.autocrew` 与 `~/Projects/broll`。媒体用真 ffmpeg 合成（ffprobe 断言是真断言），
 * 机器上没有 ffmpeg 时由调用方 `skipIf(!HAS_FFMPEG)` 整组跳过。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveContent, updateContent, type Content } from "../../../storage/local-store.js";
import { executeVideo } from "../../../tools/video.js";
import { runProcess } from "../proc.js";
import { ensureArollFixture } from "../testkit.js";
import { coverPairHash, sha256File } from "./manifest.js";
import { getContent } from "../../../storage/local-store.js";
import { resolveContentProject } from "../../../storage/content-project.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { founderProjectReview } from "./founder-review.js";
import { saveCoverage } from "./project-evidence.js";

export const HAS_FFMPEG =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

export interface HandoffFixture {
  dir: string;
  /** 白名单根（realpath 过） */
  root: string;
  /** 白名单外的目录（模拟 ~/Downloads） */
  outside: string;
  aroll: string;
  cleanup: () => Promise<void>;
}

export async function makeFixture(): Promise<HandoffFixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-handoff-data-"));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-handoff-broll-")));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-handoff-outside-"));
  await fs.writeFile(path.join(dir, "video.json"), JSON.stringify({ project_roots: [root] }));
  const aroll = path.join(outside, "aroll.mp4");
  await fs.copyFile(await ensureArollFixture(), aroll);
  const cleanup = async () => {
    for (const d of [dir, root, outside]) await fs.rm(d, { recursive: true, force: true, maxRetries: 3 });
  };
  return { dir, root, outside, aroll, cleanup };
}

export const BODY = "今天聊聊我怎么用 AI 工具省下每天两小时。第一步，把重复的事交出去。";

/** 一篇审稿结论 accepted 的抖音草稿 */
export async function seedAccepted(dir: string, title = "AI 工具分享: 第一期/上"): Promise<Content> {
  const content = await saveContent({ title, body: BODY, status: "draft_ready", platform: "douyin", tags: [] }, dir);
  await updateContent(content.id, {
    review: { status: "passed", rounds: 1, fixed: 0, issues: [], reviewedAt: new Date().toISOString() },
  }, dir);
  return content;
}

export function callVideo(dir: string, params: Record<string, unknown>, host = "claude-code"): Promise<Record<string, unknown>> {
  return executeVideo({ _dataDir: dir, _host: host, ...params });
}

/** 交接包里写给剪辑工位的认领令牌 */
export async function tokenIn(handoffFile: string): Promise<string> {
  const m = /claim_token：(clm-[\w-]+)/.exec(await fs.readFile(handoffFile, "utf-8"));
  if (!m) throw new Error(`交接包里没有认领令牌：${handoffFile}`);
  return m[1];
}

/** 合成一段 1 秒小视频；audio=false 出无音轨的屏录 */
export async function makeMp4(file: string, opts: { audio?: boolean; freq?: number } = {}): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const audio = opts.audio !== false;
  const args = [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5",
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=${opts.freq ?? 440}:duration=1`] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    ...(audio ? ["-c:a", "aac", "-shortest"] : ["-an"]),
    file,
  ];
  const result = await runProcess({ command: "ffmpeg", args, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`合成视频失败：${result.stderr}`);
  return file;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function writePng(file: string, tag: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([PNG_SIG, Buffer.from(tag)]));
  return file;
}

export async function writeJpeg(file: string, tag: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]));
  return file;
}

/** 按登记公式算两份凭据（剪辑工位那一侧要算的同一个东西） */
export async function approvalsFor(final: string, cover34: string, cover43: string): Promise<Record<string, unknown>> {
  const at = "2026-09-25T10:00:00+08:00";
  return {
    final_cut: { artifact_sha256: await sha256File(final), approved_at: at, user_message: "成片可以" },
    covers: {
      artifact_sha256: coverPairHash(await sha256File(cover34), await sha256File(cover43)),
      approved_at: at,
      user_message: "封面就这组",
    },
  };
}

/** 一条已交接、剪辑工位已认领的视频 */
export async function handedOff(dir: string, aroll: string) {
  const seeded = await seedAccepted(dir);
  const content = (await getContent(seeded.id, dir))!;
  await founderProjectReview(content.id, dir, { action: "decisions", draft_hash: draftHash(content), title: content.title, cover_text: "封面字", target_seconds: 90 });
  await saveCoverage(content, { draft_hash: draftHash(content), citations: [{ start: 0, end: content.body.indexOf("。") + 1, excerpt: content.body.slice(0, content.body.indexOf("。") + 1), evidence_id: "creator", sourceType: "creator_opinion", quote: "", verification: "创作者亲历（测试夹具）" }], reviewed_by: "writer", reviewed_at: new Date().toISOString() }, dir);
  const handoff = await callVideo(dir, { action: "handoff", content_id: content.id, aroll_path: aroll });
  if (!handoff.ok) throw new Error(JSON.stringify(handoff));
  // 剪辑认领的令牌由交接直接交给派工方（不再由第一个来的 Codex 会话兑换）
  const claim = { claim: { token: String(handoff.editor_claim_token) } };
  const root = resolveContentProject(content.id, dir)!.project_root;
  let n = 0;
  const report = async (files: Array<{ file: string; role: string; version?: number }>, extra: Record<string, unknown> = {}) => callVideo(dir, {
    action: "report", content_id: content.id, claim_token: claim.claim.token, _session: "editor-session",
    report: { request_id: `r-${++n}`, generation: 1, binding_revision: 1, session_id: "editor-session", result: `第 ${n} 次`, next_action: "继续",
      files: await Promise.all(files.map(async f => ({ path: path.relative(root, f.file), sha256: await sha256File(f.file), role: f.role, ...(f.version ? { version: f.version } : {}) }))), ...extra },
  }, "codex");
  return { id: content.id, root, manifestHash: String(handoff.manifest_hash), token: claim.claim.token, report };
}

