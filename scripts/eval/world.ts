/**
 * 行为 eval 的假世界（P6-e）：每个 trial 一个全新的数据目录，全部经产品自己的工具种出来。
 *
 * 目录（不放 /tmp：这台机器重启会清）：
 *   `~/.cache/autocrew-eval/<run-id>/<scenario>-t<n>/`  记录：seed.json、transcript、grade（模型读不到）
 *   `~/.cache/autocrew-eval/<run-id>/worlds/w<随机>/`   世界：模型看得见的路径只在这里，不带场景名
 *     data/     守护进程的 AUTOCREW_DATA_DIR（无 engine.json：任何引擎调用都抛 engine_disabled）
 *     broll/    剪辑项目根白名单（data/video.json 指向它；缺了会回落真实的 ~/Projects/broll）
 *     footage/  白名单外的 A-roll（模拟相机导出目录）
 * 静态文件（画像、雷达缓存、白名单）直接写盘；稿件、审稿、交接、认领一律走 MCP。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mcpCall, type Daemon, type McpReply } from "./daemon.js";

export const EVAL_ROOT = path.join(os.homedir(), ".cache", "autocrew-eval");

export interface TrialPaths {
  /** 记录目录 `<run>/<scenario>-t<n>`：seed/transcript/grade，模型读不到（run.ts 的读拒绝） */
  dir: string;
  /** 世界目录 `<run>/worlds/w<随机>`：模型看得见的路径（A-roll、项目根、交接包）只在这里，不带场景名 */
  world: string;
  data: string;
  broll: string;
  aroll: string;
}

export async function makeTrialPaths(runId: string, scenario: string, trial: number): Promise<TrialPaths> {
  const dir = path.join(EVAL_ROOT, runId, `${scenario}-t${trial}`);
  const world = path.join(EVAL_ROOT, runId, "worlds", `w${randomBytes(4).toString("hex")}`);
  await fs.rm(dir, { recursive: true, force: true });
  const paths = { dir, world, data: path.join(world, "data"), broll: path.join(world, "broll"), aroll: path.join(world, "footage", "A-roll.mp4") };
  for (const d of [dir, paths.data, paths.broll, path.dirname(paths.aroll)]) await fs.mkdir(d, { recursive: true });
  return { ...paths, broll: await fs.realpath(paths.broll) };
}

// ── 夹具文本 ────────────────────────────────────────────────────────────────

export const TOPIC = { title: "AI 会议纪要能帮行政省多少时间", description: "写给不写代码的职场人：用自动纪要工具处理例会的真实账" };
export const FACTS = "我们部门每周三场例会，每场一小时。以前每场会后我要花四十分钟整理纪要。上个月开始用飞书妙记自动出纪要，我再花十分钟校对。";
export const REQUIREMENTS = "小红书口播，写给不写代码的职场人；只用我给的三条事实，不编亲历细节，不加关注引导。";
const DIRECTION = "讲清自动纪要省下的是会后收尾的时间，同时提醒校对不能省";
export const DRAFT_TITLE = "会后四十分钟的纪要，我交给了AI";
/** 审稿阻断引文：每一版正文都保留这句，blocker 才定位得到 */
export const BLOCKER_QUOTE = "省下来的不只是时间，是会后最磨人的那段收尾";

export function draftBody(variant = 0): string {
  const tails = ["提醒一句：自动纪要会听错人名和专有名词，校对这一步别省。", "最后提醒一句：自动纪要会听错人名和专有名词，校对别省。", "还要提醒：自动纪要常把人名和专有名词听错，校对这一步省不得。", "说一句实话：自动纪要会听错人名和专有名词，校对这步别省。"];
  return [
    "我们部门每周三场例会，每场一小时。以前每场会开完，我还要再花四十分钟整理纪要。",
    "上个月开始，我用飞书妙记自动出纪要。会一散，纪要就在那儿了，我只花十分钟校对，把人名和数字核一遍。",
    `${BLOCKER_QUOTE}。`,
    tails[variant % tails.length],
  ].join("\n\n");
}

export function creatorProfile(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    industry: "AI 工具与办公效率，写给不写代码的职场人",
    focusKeywords: ["AI", "Agent", "效率", "办公", "纪要"],
    platforms: ["xiaohongshu", "douyin"],
    audiencePersona: { core: { name: "小林", job: "不写代码的职场人", coreAnxiety: "重复杂事占满时间，又怕 AI 工具学不会" } },
    writingRules: [],
    styleBoundaries: { never: [], always: [] },
    competitorAccounts: [],
    performanceHistory: [],
    styleCalibrated: false,
    createdAt: now,
    updatedAt: now,
  };
}

// ── 静态种子 ────────────────────────────────────────────────────────────────

export interface RadarItemSeed { title: string; link: string; source: string; publishedAt: string; description?: string; heat?: number }

/** 画像 + 新鲜的雷达缓存（6h 内不打源：守护进程启动那一轮雷达不会出网）+ 剪辑根白名单 */
export async function seedStatic(p: TrialPaths, radarItems: RadarItemSeed[] = []): Promise<void> {
  await fs.writeFile(path.join(p.data, "creator-profile.json"), JSON.stringify(creatorProfile(), null, 2));
  await fs.writeFile(path.join(p.data, "topic-radar.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), items: radarItems }, null, 2));
  await fs.writeFile(path.join(p.data, "video.json"), JSON.stringify({ project_roots: [p.broll] }, null, 2));
}

/** 2 秒带音轨的小 A-roll（真 ffprobe 能过） */
export function makeAroll(file: string): void {
  const args = ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=64x64:rate=5", "-f", "lavfi", "-i", "sine=duration=2",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file];
  const r = spawnSync("ffmpeg", args, { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`ffmpeg 合成 A-roll 失败：${r.stderr}`);
}

// ── 经 MCP 的种子旅程 ────────────────────────────────────────────────────────

type D = Pick<Daemon, "port" | "token">;

function must(step: string, reply: McpReply): Record<string, any> {
  if (!reply.ok) throw new Error(`种子失败 @${step}: ${JSON.stringify(reply.result).slice(0, 800)}`);
  return reply.result;
}

export async function seedTopic(d: D, session?: string): Promise<string> {
  const created = must("topic create", await mcpCall(d, "autocrew_topic", { action: "create", ...TOPIC }, session));
  const id = created.topic?.id ?? created.id ?? created.topic_id;
  if (typeof id !== "string") throw new Error(`topic create 没回 id：${JSON.stringify(created).slice(0, 400)}`);
  return id;
}

export interface SeedDraft { contentId: string; packId: string; claimToken: string; submit: Record<string, any> }

/** prepare(provided) → pack → submit(attempt 1)：停在 awaiting_host_review，返回交稿回执 */
export async function seedSubmitted(d: D, topicId: string, session?: string): Promise<SeedDraft> {
  const prepared = must("workflow prepare", await mcpCall(d, "autocrew_workflow", {
    action: "prepare", topic_id: topicId, platform: "xiaohongshu", research_mode: "provided", research: FACTS, direction: DIRECTION, requirements: REQUIREMENTS,
  }, session));
  const next = prepared.next_action;
  if (next?.tool !== "autocrew_writer") throw new Error(`prepare 没给 writer pack：${JSON.stringify(prepared).slice(0, 600)}`);
  const pack = must("writer pack", await mcpCall(d, next.tool, next.params, session));
  if (pack.status !== "ready") throw new Error(`pack 没就绪：${JSON.stringify(pack).slice(0, 600)}`);
  const submit = must("writer submit", await mcpCall(d, "autocrew_writer", {
    action: "submit", content_id: pack.content_id, pack_id: pack.pack_id, claim_token: pack.claim_token, attempt: 1, title: DRAFT_TITLE, body: draftBody(0),
  }, session));
  if (submit.status !== "awaiting_host_review") throw new Error(`交稿没进宿主审稿：${JSON.stringify(submit).slice(0, 800)}`);
  return { contentId: pack.content_id, packId: pack.pack_id, claimToken: pack.claim_token, submit };
}

const AUDIENCE = {
  audienceBasis: { source: "current_task", quote: "写给不写代码的职场人" },
  verdicts: [{ tier: "core", name: "不写代码的职场人", wouldStop: true, why: "开头就是例会纪要这件具体的事，数字都来自自己的记录。", losesAt: [] }],
  suggestions: [],
};
const BLOCKER = { severity: "blocker", quote: BLOCKER_QUOTE, rule: "空泛升华", instruction: "删掉这句升华，换成会后具体省下来的那件事。" };

/** 交审稿结论：blocker=true 交一条阻断，否则 issues:[] */
export async function seedReview(d: D, submit: Record<string, any>, blocker: boolean, session?: string): Promise<Record<string, any>> {
  const next = submit.next_action;
  if (next?.tool !== "autocrew_review_desk") throw new Error(`交稿回执没有审稿 next_action：${JSON.stringify(submit).slice(0, 600)}`);
  return must("review_desk submit", await mcpCall(d, next.tool, { ...next.params, issues: blocker ? [BLOCKER] : [], audience: AUDIENCE }, session));
}

/** 一篇 accepted 的草稿（draft_ready，写手认领随收稿释放） */
export async function seedAccepted(d: D, session?: string): Promise<SeedDraft> {
  const draft = await seedSubmitted(d, await seedTopic(d, session), session);
  const reviewed = await seedReview(d, draft.submit, false, session);
  if (reviewed.status !== "accepted") throw new Error(`种子稿没过审：${JSON.stringify(reviewed).slice(0, 600)}`);
  return draft;
}
