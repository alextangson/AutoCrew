import { projectBundle } from "./project-bundle.js";
import { assertManagedPathAvailable } from "../../../storage/storage-roots.js";
import { contentFile, resolveContentProject, safeProjectPath } from "../../../storage/content-project.js";
/**
 * `autocrew_video handoff`：Claude 会话把一条审过的稿交给 Codex 剪辑工位（P6 spec §3.4）。
 *
 * 校验顺序照 spec 字面：**重放 → 阶段 → A-roll → 路径**，写门（P6 §3.8）在只读核验之后、第一次落盘之前。
 * 重放必须在阶段门之前——交出去之后状态已是 editing、认领已在 codex 手上，同一份请求重发
 * （网络抖动、双击）不该被拒成「不能交接」或 claim_held。
 *
 * 落盘顺序：认领转给剪辑工位（新令牌要写进交接包）→ 两份交接包 → 状态 + 交接记录同一次写。
 * 后两步任一失败都退回：删掉刚写的交接包、认领退回调用方，状态从未推进。
 * 进程在中途崩掉留下的孤儿交接包不会被覆盖（文件不可变），下一次交接自动跳到更高代次。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { transferClaim, type WriteGate } from "../../../storage/claims.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { contentDir, getContent, transitionStatus, type Content } from "../../../storage/local-store.js";
import { probeAroll } from "../ingest.js";
import { acceptanceBlock, HANDOFF_FROM } from "./acceptance.js";
import { serializeVideoLine } from "./lock.js";
import {
  buildManifest,
  dispatchText,
  manifestHash,
  MAX_HANDOFF_BYTES,
  renderHandoffFile,
  sha256File,
  type HandoffFileInput,
} from "./manifest.js";
import { claimProjectDir, defaultProjectName, resolveProjectRoot, SCRIPT_DIR } from "./paths.js";
import { expandHome, usableRoots, type ProjectRoots } from "./roots.js";
import { handoffFail, type HandoffManifest, type HandoffResult, type VideoHandoffRecord } from "./types.js";

/** 剪辑工位的宿主名（命名 token 的主体）：交接把认领转给它 */
export const EDITOR_HOST = "codex";

export interface HandoffInput {
  contentId: string;
  arollPath: string;
  projectRoot?: string;
  notes?: string;
  host: string;
  session?: string;
  claimToken?: string;
}

export interface HandoffContext {
  dataDir: string;
  /** 写门（P6 §3.8）：重放与只读核验之后、第一次落盘之前才过；放行时 grant 里的令牌要随回执交回 */
  gate: () => Promise<WriteGate>;
}

export type Grant = { claim_token?: string };

interface Plan {
  content: Content;
  arollPath: string;
  projectRoot: string;
  base: Omit<HandoffManifest, "generation">;
}

type Planned = { ok: true; plan: Plan } | { ok: false; result: HandoffResult };

export function handedOffResult(record: VideoHandoffRecord, extra: Record<string, unknown> = {}): HandoffResult {
  return {
    ok: true,
    status: "handed_off",
    content_id: record.content_id,
    generation: record.generation,
    manifest_hash: record.hash,
    project_root: record.project_root,
    handoff_path: record.handoff_path,
    project_handoff_path: record.project_handoff_path,
    dispatch_text: dispatchText(record, record.project_handoff_path),
    note: "认领已转给剪辑工位（codex）；在 project_root 读取 AGENTS.md 与当前交接包。登记回来之前本稿不可改。",
    ...extra,
  };
}

async function readableFile(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.R_OK);
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** 算出这次请求对应的清单（代次待定）：重放比对与正式交接用同一份 */
async function planHandoff(content: Content, input: HandoffInput, roots: ProjectRoots, dataDir: string): Promise<Planned> {
  const arollPath = path.resolve(expandHome(input.arollPath.trim()));
  if (!(await readableFile(arollPath))) {
    return { ok: false, result: handoffFail("aroll_invalid", `找不到 A-roll 或读不了：${arollPath}`) };
  }
  const binding = resolveContentProject(content.id, dataDir);
  if (binding && input.projectRoot && path.resolve(input.projectRoot) !== path.resolve(binding.project_root)) return { ok: false, result: handoffFail("project_binding_conflict", "必须复用写稿时的项目目录") };
  const requested = binding?.project_root || input.projectRoot?.trim()
    || content.video?.handoff?.project_root
    || path.join(roots.roots[0], defaultProjectName(content.title));
  const resolved = await resolveProjectRoot(requested, roots);
  if (!resolved.ok) return { ok: false, result: resolved.result };
  const base = {
    content_id: content.id,
    draft_hash: draftHash(content),
    aroll_sha256: await sha256File(arollPath),
    project_root: resolved.value,
    notes: binding ? (input.notes ?? "") : (input.notes ?? "").trim(),
  };
  return { ok: true, plan: { content, arollPath, projectRoot: resolved.value, base } };
}

/** 重放：当前交接未撤回、状态已离开可交接态、同一份清单 → 原样返回（不重写任何东西） */
async function replayOf(content: Content, base: Plan["base"], dataDir: string): Promise<VideoHandoffRecord | null> {
  const current = content.video?.handoff;
  if (!current || (content.video?.revoked ?? []).includes(current.hash)) return null;
  if (HANDOFF_FROM.has(content.status)) return null;
  const manifest = { ...base, generation: current.generation };
  const bundle = await projectBundle(content, manifest, dataDir);
  return manifestHash(bundle?.manifest ?? manifest) === current.hash ? current : null;
}

function handoffDir(contentId: string, dataDir: string): string {
  return contentFile(contentId, dataDir, "handoff");
}

/** 下一代次 = 已提交代次与盘上已有交接包代次的最大值 + 1（孤儿包占住的号不复用） */
async function nextGeneration(content: Content, dataDir: string): Promise<number> {
  let max = content.video?.handoff?.generation ?? 0;
  const binding = resolveContentProject(content.id, dataDir);
  if (binding) {
    for (const name of await fs.readdir(path.join(binding.project_root, "01-script/handoff"))) {
      const m = /^g(\d+)$/.exec(name); if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }
  try {
    for (const name of await fs.readdir(handoffDir(content.id, dataDir))) {
      const m = /^editor-g(\d+)\.md$/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {
    /* 目录还没有 = 第一次交接 */
  }
  return max + 1;
}

/** 不可变写：独占创建；已存在且内容不同 → null（冲突），相同 → false（没新建） */
async function writeImmutable(file: string, text: string): Promise<boolean | null> {
  assertManagedPathAvailable(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, text, { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return (await fs.readFile(file, "utf-8")) === text ? false : null;
  }
}

export async function handoffVideo(input: HandoffInput, ctx: HandoffContext): Promise<HandoffResult> {
  return serializeVideoLine(input.contentId, () => handoffLocked(input, ctx));
}

async function handoffLocked(input: HandoffInput, ctx: HandoffContext): Promise<HandoffResult> {
  const content = await getContent(input.contentId, ctx.dataDir);
  if (!content) return handoffFail("invalid_params", `稿件不存在：${input.contentId}`);
  const roots = await usableRoots(ctx.dataDir);
  if (!roots.ok) return roots.result;
  const planned = await planHandoff(content, input, roots.value, ctx.dataDir);
  if (!planned.ok) return planned.result;
  const replay = await replayOf(content, planned.plan.base, ctx.dataDir);
  if (replay) return handedOffResult(replay, { replayed: true, content_status: content.status });

  const blocked = acceptanceBlock(content);
  if (blocked) return blocked;
  const probed = await probeAroll(planned.plan.arollPath);
  if (!probed.ok) return handoffFail("aroll_invalid", probed.reason);
  // 写门放在只读核验之后、第一次落盘之前：被拒的请求不留认领这种副作用
  const gate = await ctx.gate();
  if ("denied" in gate) return gate.denied;
  return commitHandoff(planned.plan, input, ctx, gate.grant);
}

interface Prepared {
  bundle?: Record<string, string>;
  manifest: HandoffManifest;
  record: VideoHandoffRecord;
  fileInput: HandoffFileInput;
}

async function prepareCommit(plan: Plan, input: HandoffInput, dataDir: string): Promise<Prepared> {
  const generation = await nextGeneration(plan.content, dataDir);
  const bundle = await projectBundle(plan.content, buildManifest({ ...plan.base, generation }), dataDir);
  const manifest = bundle?.manifest ?? buildManifest({ ...plan.base, generation });
  const hash = manifestHash(manifest);
  const record: VideoHandoffRecord = {
    ...manifest,
    hash,
    at: new Date().toISOString(),
    by: input.host,
    ...(input.session ? { session: input.session } : {}),
    version: plan.content.versions?.length ?? 1,
    aroll_path: plan.arollPath,
    handoff_path: path.join(handoffDir(plan.content.id, dataDir), `editor-g${generation}.md`),
    project_handoff_path: path.join(plan.projectRoot, SCRIPT_DIR, `autocrew-handoff-g${generation}.md`),
  };
  if (bundle) {
    const bundleFile = path.join(plan.projectRoot, `01-script/handoff/g${String(generation).padStart(4, "0")}/handoff.md`);
    record.handoff_path = bundleFile; record.project_handoff_path = bundleFile;
    record.aroll_path = path.join(plan.projectRoot, "02-aroll", `${manifest.aroll_sha256}${path.extname(plan.arollPath).toLowerCase()}`);
  }
  const fileInput = { title: plan.content.title, manifest, hash, body: plan.content.body, arollPath: plan.arollPath };
  return { manifest, record, fileInput, ...(bundle ? { bundle: bundle.files } : {}) };
}

async function commitHandoff(plan: Plan, input: HandoffInput, ctx: HandoffContext, grant: Grant): Promise<HandoffResult> {
  const prepared = await prepareCommit(plan, input, ctx.dataDir);
  // 令牌长度固定量级，拿占位令牌先量一次：超限就别动认领
  const sized = renderHandoffFile({ ...prepared.fileInput, claimToken: "clm-0000000000000-00000000" });
  if (!prepared.bundle && Buffer.byteLength(sized) > MAX_HANDOFF_BYTES) {
    return { ...handoffFail("handoff_too_large", `交接包超过 ${MAX_HANDOFF_BYTES / 1024} KB（正文或备注太长）`), ...grant };
  }
  const owned = await claimProjectDir(plan.projectRoot, plan.content.id);
  if (!owned.ok) return { ...owned.result, ...grant };
  const moved = await transferClaim(plan.content.id, {
    token: grant.claim_token ?? input.claimToken,
    host: input.host,
    toEmployee: "editor",
    toHost: EDITOR_HOST,
    note: `交接剪辑 g${prepared.record.generation}`,
  }, ctx.dataDir);
  if (!moved.ok) {
    return { ...handoffFail("handoff_failed", moved.error, moved.holder ? { holder: moved.holder } : {}), ...grant };
  }
  return landHandoff(plan, input, ctx, prepared, moved.claim.token);
}

/** 写两份交接包 → 状态与记录同一次落盘；失败就删包、认领退回、状态不动 */
async function landHandoff(
  plan: Plan,
  input: HandoffInput,
  ctx: HandoffContext,
  prepared: Prepared,
  editorToken: string,
): Promise<HandoffResult> {
  const { record } = prepared;
  const text = renderHandoffFile({ ...prepared.fileInput, claimToken: editorToken });
  const created: string[] = [];
  let failure: HandoffResult;
  try {
    if (prepared.bundle) {
      assertManagedPathAvailable(record.aroll_path);
      safeProjectPath(plan.projectRoot, path.relative(plan.projectRoot, record.aroll_path));
      await fs.mkdir(path.dirname(record.aroll_path), { recursive: true });
      try { await fs.copyFile(plan.arollPath, record.aroll_path, fs.constants.COPYFILE_EXCL); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      if (await sha256File(record.aroll_path) !== record.aroll_sha256) throw new Error("A-roll 校验失败");
    }
    const files = prepared.bundle ? Object.entries(prepared.bundle).map(([p, t]) => [safeProjectPath(plan.projectRoot, p), t]) : [[record.handoff_path, text], [record.project_handoff_path, text]];
    for (const [file, body] of files) {
      const wrote = await writeImmutable(file, body);
      if (wrote === null) throw Object.assign(new Error(`交接包已存在且内容不同，不覆盖：${file}`), { code: "handoff_file_exists" });
      if (wrote) created.push(file);
    }
    const moved = await transitionStatus(plan.content.id, "editing", {
      expectedStatus: plan.content.status,
      expectedDraft: { title: plan.content.title, body: plan.content.body, platform: plan.content.platform },
      host: input.host,
      viaHandoff: true,
      patch: (current) => ({ video: { ...current.video, handoff: record }, ...(record.v2 && current.claim ? { claim: { ...current.claim, pendingHandoff: true } } : {}) }),
    }, ctx.dataDir);
    if (moved.ok) return handedOffResult(record, { content_status: "editing" });
    failure = handoffFail("handoff_failed", `状态没推进：${moved.error ?? "未知原因"}`);
  } catch (err) {
    const code = (err as { code?: string }).code === "handoff_file_exists" ? "handoff_file_exists" : "handoff_failed";
    failure = handoffFail(code, err instanceof Error ? err.message : String(err));
  }
  return { ...failure, ...(await undoHandoff(plan.content.id, created, editorToken, input, ctx.dataDir)) };
}

async function undoHandoff(contentId: string, created: string[], editorToken: string, input: HandoffInput, dataDir: string): Promise<Grant> {
  for (const file of created) await fs.rm(file, { force: true }).catch(() => undefined);
  const back = await transferClaim(contentId, {
    token: editorToken,
    host: input.host,
    toEmployee: "writer",
    toHost: input.host,
    note: "交接未完成，认领退回",
  }, dataDir);
  return back.ok ? { claim_token: back.claim.token } : {};
}
