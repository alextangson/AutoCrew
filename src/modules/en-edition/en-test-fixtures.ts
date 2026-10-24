/**
 * 英文版测试共用：本体启用、成片已批并登记了 4 条字幕的源视频，和一份对得上的三段脚本。
 */
import path from "node:path";
import { expect } from "vitest";
import { readProductionDoc } from "../../storage/production-store.js";
import { founderDecision } from "../production/decisions.js";
import { founderApprove, makeEnv, put, record, videoContent, waiveSliverCheck, type Env } from "../production/testkit.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";

export const EN_SRT = [
  "1\n00:00:00,000 --> 00:00:04,000\n说实话，任务越难越想开最大",
  "2\n00:00:04,000 --> 00:00:08,000\n腾讯的同事刚发了一个测试",
  "3\n00:00:08,500 --> 00:00:14,000\n同样的难题，同一个模型",
  "4\n00:00:14,000 --> 00:00:20,000\n看完数字我反而信了相反的结论",
].join("\n\n") + "\n";

export const SEGMENTS = [
  { cues: "1", en: "Be honest. The harder the task, the more you crank it up." },
  { cues: "2", en: "Tariq, who works on Claude Code, just published a test.", swaps: [{ from: "腾讯的同事", to: "Tariq at Anthropic", reason: "西方观众不熟腾讯内部" }] },
  { cues: "3-4", en: "Same hard problems, same model. After those numbers, I believe the opposite.", keyword: "the opposite" },
];

export async function enSourceVideo(platforms: string[]): Promise<{ env: Env; id: string }> {
  const env = await makeEnv({ enabled: true });
  await initProfile(env.dir);
  await updateProfile({ platforms }, env.dir);
  const c = await videoContent(env, "深度思考开到 max");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "深度思考-原片.mov"), "raw"), request_id: "a" });
  const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "深度思考.mp4"), "cut-v1"), request_id: "c", review: true });
  await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "a.srt"), EN_SRT), for_cut: cut.fact_id, request_id: "s" });
  const doc = (await readProductionDoc(c.id, env.dir))!;
  const sha = doc.facts.find((f) => f.id === cut.fact_id)!.sha256!;
  await waiveSliverCheck(env, c.id, sha);
  expect(await founderDecision(c.id, "approve_cut", { fact_id: cut.fact_id, sha256: sha }, env.dir)).toMatchObject({ ok: true });
  return { env, id: c.id };
}
