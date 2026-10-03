/**
 * 观察生命周期（observation-lifecycle.md，规格 §五）：
 *   观察记录 → 跨视频观察（≥2 样本）/ 待验证假设（单样本强信号暂存）→ 规律沉淀 / 吸收为维度（走升级）/ 被推翻 → 删除（留墓碑）。
 * 复盘产出的观察默认只进观察记录，不直接变写作规则；沉淀出的规律只建「待批」写作规则，生效由创始人批。
 * 写作规则从不被数据自动改：数据与已有规则冲突时只提示（创始人原话定的单独标出）。
 */
import crypto from "node:crypto";
import { addWritingRule, loadProfile } from "../profile/creator-profile.js";
import { decodeArg } from "../meetings/meeting-args.js";
import { BLIND_LEAK_RE, CROSS_VIDEO_MIN_SAMPLES } from "./constants.js";
import { normText, projectObservations, readObservations, type Observation } from "./obs-store.js";
import { requireText } from "./predict-input.js";
import { appendLog, ensureCalibration, serializeCalibration, writeRubric, writeState } from "./store.js";

type Obj = Record<string, unknown>;
const RETIRE_REASONS = ["absorbed", "refuted", "settled"] as const;

function samples(raw: unknown): string[] {
  const d = decodeArg(raw ?? []);
  if (!Array.isArray(d) || d.some((x) => typeof x !== "string")) throw new Error("sample_ids 必须是预测 id 数组");
  return d as string[];
}

async function findLive(id: unknown, dataDir?: string): Promise<Observation> {
  const { live } = await readObservations(dataDir);
  const o = live.find((x) => x.id === id);
  if (!o) throw new Error(`观察「${String(id)}」不在当前观察区（可能已删除）`);
  return o;
}

/** 门槛：默认 ≥2 样本；不够就必须写软违反理由，标注「Promoted with N samples (default expects M)」 */
function thresholdNote(o: Observation, extra: string[], soft: unknown, label: string): { ids: string[]; note?: string } {
  const ids = [...new Set([...o.sample_ids, ...extra])];
  if (ids.length >= CROSS_VIDEO_MIN_SAMPLES) return { ids };
  const reason = typeof soft === "string" ? soft.trim() : "";
  if (!reason) throw new Error(`${label}默认要 ≥${CROSS_VIDEO_MIN_SAMPLES} 个样本（现在 ${ids.length} 个）：单样本强信号要写 soft_reason`);
  return { ids, note: `Promoted with ${ids.length} samples (default expects ${CROSS_VIDEO_MIN_SAMPLES}): ${reason}` };
}

/** rubric.json 的观察区跟着观察生命周期刷新（只投影抽象文本） */
export async function reproject(dataDir?: string): Promise<void> {
  const { rubric } = await ensureCalibration(dataDir);
  const { live } = await readObservations(dataDir);
  await writeRubric({ ...rubric, observations: projectObservations(live, (t) => BLIND_LEAK_RE.test(t)) }, dataDir);
}

async function add(args: Obj, dataDir?: string): Promise<Obj> {
  const text = requireText(args.text, "text");
  const { tombstones } = await readObservations(dataDir);
  const dead = tombstones.find((t) => normText(t.text) === normText(text));
  if (dead) return { ok: false, code: "tombstoned", error: `这条观察以前已${dead.reason === "refuted" ? "被推翻" : "被吸收/沉淀"}（${dead.id}），不重提` };
  const id = `obs-${crypto.randomUUID().slice(0, 8)}`;
  await appendLog("rubric-memo", { type: "observation", id, stage: "observation", text, sample_ids: samples(args.sample_ids), source: String(args.source ?? "host"), at: new Date().toISOString() }, dataDir);
  return { ok: true, id, stage: "observation", in_rubric: !BLIND_LEAK_RE.test(text) };
}

async function promote(args: Obj, dataDir?: string): Promise<Obj> {
  const o = await findLive(args.id, dataDir);
  const to = String(args.to);
  if (to !== "cross_video" && to !== "hypothesis") throw new Error("to 只能是 cross_video 或 hypothesis（沉淀用 settle，吸收为维度走 calib_bump）");
  const gate = to === "cross_video" ? thresholdNote(o, samples(args.sample_ids), args.soft_reason, "升为跨视频观察") : { ids: [...new Set([...o.sample_ids, ...samples(args.sample_ids)])] };
  await appendLog("rubric-memo", { type: "obs_stage", id: o.id, stage: to, sample_ids: gate.ids, ...("note" in gate && gate.note ? { soft_note: gate.note } : {}), at: new Date().toISOString() }, dataDir);
  return { ok: true, id: o.id, stage: to, ...("note" in gate ? { soft_note: gate.note } : {}) };
}

async function settle(args: Obj, dataDir?: string): Promise<Obj> {
  const o = await findLive(args.id, dataDir);
  const gate = thresholdNote(o, samples(args.sample_ids), args.soft_reason, "沉淀为规律");
  await appendLog("rubric-memo", { type: "obs_stage", id: o.id, stage: "settled", sample_ids: gate.ids, ...(gate.note ? { soft_note: gate.note } : {}), at: new Date().toISOString() }, dataDir);
  const rule = typeof args.rule === "string" && args.rule.trim() ? args.rule.trim() : o.text;
  const profile = await addWritingRule({ rule, source: "auto_distilled", confidence: 0.6, evidence: [`校准观察 ${o.id}：${o.text}`, `样本：${gate.ids.join("、")}`] }, dataDir);
  return { ok: true, id: o.id, stage: "settled", writing_rule: profile.lastRuleOutcome, note: "写作规则只建成「待批」，由创始人在工作台批准后才生效" };
}

async function retire(args: Obj, dataDir?: string): Promise<Obj> {
  const o = await findLive(args.id, dataDir);
  const reason = String(args.reason);
  if (!(RETIRE_REASONS as readonly string[]).includes(reason)) throw new Error("reason 只能是 absorbed / refuted / settled");
  await appendLog("rubric-memo", { type: "obs_delete", id: o.id, reason, note: typeof args.note === "string" ? args.note : null, at: new Date().toISOString() }, dataDir);
  return { ok: true, id: o.id, deleted: true, tombstone: true };
}

/** 数据与已有写作规则冲突：只提示，不改规则；创始人原话定的单独标出 */
async function ruleConflict(args: Obj, dataDir?: string): Promise<Obj> {
  const o = await findLive(args.id, dataDir);
  const profile = await loadProfile(dataDir);
  const rule = profile?.writingRules.find((r) => r.id === args.rule_id);
  if (!rule) throw new Error(`写作规则「${String(args.rule_id)}」不存在`);
  const founder = rule.source === "user_explicit";
  return { ok: true, changed: false, conflict: { rule_id: rule.id, rule: rule.rule, observation: o.text, founder_rule: founder },
    next_action: founder ? "这条是创始人原话定的规则：数据不自动删，把冲突摆给创始人裁定" : "数据只提示冲突，不自动改规则：摆给创始人决定是否停用或改写" };
}

const OPS: Record<string, (a: Obj, d?: string) => Promise<Obj>> = { add, promote, settle, retire, rule_conflict: ruleConflict };

export async function observe(args: Obj, dataDir?: string): Promise<Obj> {
  const op = String(args.op ?? "list");
  if (op === "list") {
    const { live, tombstones } = await readObservations(dataDir);
    return { ok: true, observations: live, tombstones };
  }
  if (op === "cleanup_done") {
    return serializeCalibration(dataDir, async () => {
      const { state } = await ensureCalibration(dataDir);
      await writeState({ ...state, samples_at_last_cleanup: state.calibration_samples }, dataDir);
      return { ok: true, samples_at_last_cleanup: state.calibration_samples };
    });
  }
  const fn = OPS[op];
  if (!fn) throw new Error(`op 只能是 list / add / promote / settle / retire / rule_conflict / cleanup_done`);
  return serializeCalibration(dataDir, async () => {
    const r = await fn(args, dataDir);
    if (r.ok && op !== "rule_conflict") await reproject(dataDir);
    return r;
  });
}
