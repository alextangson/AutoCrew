/**
 * 英文版测试共用：本体启用、成片已批并登记了 4 条字幕的源视频，一份对得上的三段脚本，假 ElevenLabs，批脚本。
 */
import path from "node:path";
import { expect } from "vitest";
import { readProductionDoc } from "../../storage/production-store.js";
import { founderDecision } from "../production/decisions.js";
import { founderApprove, makeEnv, put, record, videoContent, waiveSliverCheck, type Env } from "../production/testkit.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { readInbox } from "../production/inbox-read.js";
import { decideItem } from "../production/inbox-decide.js";
import { setDurationProbe } from "./dub.js";
import { setElevenLabsFetch } from "../voice/elevenlabs.js";

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

/** 逐字符的假时间戳（每字 0.05 秒） */
export function fakeAlignment(text: string) {
  const chars = [...text];
  return { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => i * 0.05 + 0.04) };
}

export interface FakeCall { url: string; text: string; key: string }

/**
 * 假 ElevenLabs：按文字回 mp3 字节 + 时间戳。respond(text, 第几次调用) 返回 Response 就用它（失败、坏时间戳…），
 * 返回 undefined 走正常回复。durations 控制每段测到的时长。
 */
export function fakeElevenLabs(durations: number[], respond?: (text: string, n: number) => Response | undefined): FakeCall[] {
  const calls: FakeCall[] = [];
  let probes = 0;
  setDurationProbe(async () => durations[Math.min(probes++, durations.length - 1)]);
  setElevenLabsFetch((async (url: string, init: RequestInit) => {
    const text = String((JSON.parse(String(init.body)) as { text: string }).text);
    calls.push({ url, text, key: String((init.headers as Record<string, string>)["xi-api-key"]) });
    const custom = respond?.(text, calls.length);
    if (custom) return custom;
    return new Response(JSON.stringify({ audio_base64: Buffer.from(`mp3:${text}`).toString("base64"), alignment: fakeAlignment(text) }), { status: 200 });
  }) as typeof fetch);
  return calls;
}

/** 认稿那件批脚本（和创始人在对话里说「没问题」同一条路） */
export async function approveEnScript(env: Env, id: string): Promise<Record<string, unknown>> {
  const d = (await readInbox(env.dir, { withDrafts: true })).items.find((i) => i.type === "draft" && i.content_id === id)!;
  return decideItem({ item_id: d.item_id, gen: d.gen, action: "approve_script", content_id: id }, env.dir);
}
