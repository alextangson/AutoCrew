/** 发布前把关测试共用：造一条已登记的视频、计划条目、假 Jev（不连网）。只给测试用 */
import path from "node:path";
import { getContent } from "../../../storage/local-store.js";
import { readProductionDoc } from "../../../storage/production-store.js";
import { founderDecision } from "../../production/decisions.js";
import { registeredPackage } from "../../production/publish-gate.js";
import { founderApprove, png, projectRoot, put, record, videoContent, type Env, waiveSliverCheck } from "../../production/testkit.js";
import type { JevAnswer, JevCaller, JevQuestion } from "./jev-client.js";

export const SRT_TEXT = "1\n00:00:00,000 --> 00:00:05,000\nAI 老是忘事，我试了 3 个办法，效率提升了 73%\n\n2\n00:00:05,000 --> 00:00:10,000\n第一个办法是把规则写进文件\n";
export const CAPTION = "AI 总忘事？这期讲我试过的办法，看完就能用上。#AI工具";

export async function registeredVideo(env: Env, coverText = "AI 又忘了？") {
  const c = await videoContent(env, "AI 又忘了怎么办");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
  const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "AI又忘了怎么办.mp4"), "cut-v1"), request_id: "c" });
  await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "a.srt"), SRT_TEXT), for_cut: cut.fact_id, request_id: "s" });
  const c34 = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c34.png"), png(900, 1200)), request_id: "p1" });
  const c43 = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c43.png"), png(1200, 900)), version: 1, request_id: "p2" });
  const doc = (await readProductionDoc(c.id, env.dir))!;
  const sha = (id: unknown) => doc.facts.find((f) => f.id === id)!.sha256!;
  await waiveSliverCheck(env, c.id, sha(cut.fact_id));
  await founderDecision(c.id, "approve_cut", { fact_id: cut.fact_id, sha256: sha(cut.fact_id) }, env.dir);
  await founderDecision(c.id, "pick_cover", { cover_3x4_fact_id: c34.fact_id, cover_3x4_sha: sha(c34.fact_id), cover_4x3_fact_id: c43.fact_id, cover_4x3_sha: sha(c43.fact_id), cover_text: coverText }, env.dir);
  const gate = await registeredPackage((await getContent(c.id, env.dir))!, env.dir);
  if (!gate?.ok) throw new Error(`没登记上：${JSON.stringify(gate)}`);
  const root = projectRoot(env, c.id);
  const rel = (p: string) => path.relative(root, p);
  return { id: c.id, root, video: rel(gate.files.video), c34: rel(gate.files.cover34), c43: rel(gate.files.cover43) };
}

export type Reg = Awaited<ReturnType<typeof registeredVideo>>;

export function planEntry(r: Reg, platform: string, covers: Array<"3:4" | "4:3">, extra: Record<string, unknown> = {}) {
  return { platform, content_id: r.id, account_display_name: "哈姆雷鹿", title: "AI 老忘事的办法", caption: CAPTION, cover_text: "AI 又忘了？",
    covers: covers.map((ratio) => ({ usage: ratio === "3:4" ? "竖版封面" : "横版封面", ratio, path: ratio === "3:4" ? r.c34 : r.c43 })), ...extra };
}
export const planOf = (r: Reg, platforms: unknown[]) => ({ final_video: { path: r.video }, platforms });

/** 假 Jev：全部「没问题」；记下每次请求 */
export function fakeJev(overrides: (id: string, q: JevQuestion) => JevAnswer | undefined = () => undefined) {
  const calls: Array<{ state: unknown; questions: Record<string, JevQuestion> }> = [];
  const caller: JevCaller = async (state, questions) => {
    calls.push({ state, questions });
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      const forced = overrides(id, q);
      if (forced) { answers[id] = forced; continue; }
      if (q.type === "noul") answers[id] = { type: "noul", noul: id.startsWith("v") ? 0.05 : 0.9 };
      else {
        const pickKey = id === "a1" ? "准确" : "不约束发布内容";
        answers[id] = { type: "choice", choice: pickKey, probabilities: { [pickKey]: 1 }, confidence: 0.8 };
      }
    }
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 400, output_tokens: 20 }, ms: 5 };
  };
  return { caller, calls };
}
