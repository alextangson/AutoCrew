/**
 * 本体测试共用：临时资料库工作区（layout v2）、注入的可搬入根与探针、造文件（默认改成 60 秒前修改，过完整性门）。
 * 不碰真实 ~/Movies、资料库与 ~/.autocrew。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeProjectLayout, resolveContentProject } from "../../storage/content-project.js";
import { getContent, saveContent, type Content, type ContentStatus } from "../../storage/local-store.js";
import { commitProjectContent } from "../../storage/project-commit.js";
import { executeContentSave } from "../../tools/content-save.js";
import { setProductionDeps } from "./roots.js";
import { movableWatchFolders } from "./sources.js";
import { setChatcutDeps } from "./sliver/chatcut-read.js";
import { writeEnabledVersion } from "../../storage/production-store.js";
import { resetProductionReady } from "./service.js";
import { forgetShaIndex } from "./sha-index.js";
import { setMatchDeps } from "./match/deps.js";
import { matchWorkerIdle, resetMatchQueue } from "./match/queue.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

export interface Env { dir: string; inbox: string; chatcut: string; jianying: string; outside: string; cleanup: () => Promise<void> }

/** enabled：本体已对这个临时库启用（record / 重开文稿只在启用后工作） */
export async function makeEnv(opts: { enabled?: boolean } = {}): Promise<Env> {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-ontology-")));
  const dir = path.join(temp, "workspace");
  const [inbox, chatcut, jianying, outside] = ["inbox", "chatcut", "jianying", "outside"].map((d) => path.join(temp, d));
  for (const d of [dir, inbox, chatcut, jianying, outside]) await fs.mkdir(d, { recursive: true });
  await initializeProjectLayout(dir, "lib-deadbeef", "default");
  resetProductionReady();
  forgetShaIndex();
  resetMatchQueue();
  setMatchDeps(null);
  // 隐式 ChatCut 引用守卫：测试一律读临时目录（默认不存在 = 没装 ChatCut），绝不读本机真实工程
  setChatcutDeps({ projectsRoot: () => path.join(temp, "chatcut-projects") });
  setProductionDeps({
    roots: async (d) => ({ inbox, chatcut, jianying, watch: await movableWatchFolders(d) }),
    // 假探针：文件名带 broken 的读不出时长，其余 12 秒
    probe: async (file) => (path.basename(file).includes("broken") ? { error: "moov atom not found" } : { durationMs: 12_000 }),
    now: () => Date.now(),
  });
  if (opts.enabled) await writeEnabledVersion(dir);
  return { dir, inbox, chatcut, jianying, outside, cleanup: async () => { await matchWorkerIdle(dir); setProductionDeps(null); setChatcutDeps(null); setMatchDeps(null); resetMatchQueue(); resetProductionReady(); forgetShaIndex(); await fs.rm(temp, { recursive: true, force: true }); } };
}

/** 写文件并把修改时间拨到 60 秒前（过「10 秒内不变」门）；fresh=true 保留刚写的时间 */
export async function put(file: string, bytes: string | Buffer, fresh = false): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  if (!fresh) {
    const t = new Date(Date.now() - 60_000);
    await fs.utimes(file, t, t);
  }
  return file;
}

/** 最小 PNG：签名 + IHDR（宽高），后面拼 seed 让字节不同 */
export function png(width: number, height: number, seed = "x"): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from(seed)]);
}

export const SRT = "1\n00:00:00,000 --> 00:00:02,000\n你好\n";

const CREATABLE = new Set<ContentStatus>(["drafting", "draft_ready", "reviewing", "revision", "approved", "published", "archived"]);

/** 造一条视频稿；阶段门不许直接建的旧状态（剪辑中 / 封面 / 待发布）直接写 meta，模拟旧库里的现状 */
export async function videoContent(env: Env, title: string, status: ContentStatus = "draft_ready", body = `${title} 的定稿正文。`, extra: Partial<Content> = {}): Promise<Content> {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title, body, platform: "douyin", status: CREATABLE.has(status) ? status : "approved", tags: [] }, env.dir);
  if (CREATABLE.has(status) && !Object.keys(extra).length) return c;
  const next = { ...(await getContent(c.id, env.dir))!, status, ...extra };
  await commitProjectContent(next, env.dir);
  return next;
}

/** 直接改 meta（模拟旧库现状，绕开阶段门） */
export async function setContent(env: Env, id: string, patch: Partial<Content>): Promise<Content> {
  const next = { ...(await getContent(id, env.dir))!, ...patch };
  await commitProjectContent(next, env.dir);
  return next;
}

/** 创始人认稿：工作台（非模型）把 draft_ready 推到 approved，写认稿决定 */
export async function founderApprove(env: Env, id: string): Promise<void> {
  const r = await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, action: "transition", id, target_status: "approved", force: true });
  if (!(r as { ok: boolean }).ok) throw new Error(`认稿失败：${JSON.stringify(r)}`);
}

export function projectRoot(env: Env, id: string): string {
  return resolveContentProject(id, env.dir)!.project_root;
}

export function record(env: Env, params: Record<string, unknown>, host = "codex"): Promise<Record<string, unknown>> {
  return executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: host, action: "record", ...params }) as Promise<Record<string, unknown>>;
}

export async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true, () => false);
}

/**
 * 抽帧检查默认拦「成片通过」（spec 2026-09-30 §12-1）：与抽帧无关的测试里，临时库没有 ChatCut 工程记录，
 * 检查必然「没跑成」——先替创始人点「这条不查了，放行」，再测别的。
 */
export async function waiveSliverCheck(env: Env, contentId: string, cutSha: string): Promise<void> {
  const { founderDecision } = await import("./decisions.js");
  const r = await founderDecision(contentId, "waive_sliver_check", { cut_sha: cutSha }, env.dir);
  if (!(r as { ok: boolean }).ok) throw new Error(`整条放行失败：${JSON.stringify(r)}`);
}
