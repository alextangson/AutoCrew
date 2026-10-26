/**
 * 无字幕母版（record kind=clean_master，2026-10-25）：绑审过的成片；ffprobe 核 1920×1080、有音轨、时长对得上；captions_off 声明必带。
 * 英文版拿它当画面来源，没有就拒并指路。
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { readProductionDoc } from "../../storage/production-store.js";
import { setProductionDeps } from "./roots.js";
import { put, record, type Env } from "./testkit.js";
import { reconcileContent } from "./reconcile.js";
import { mutateProduction } from "./service.js";
import { enSourceVideo, SEGMENTS, approveEnScript, fakeElevenLabs } from "../en-edition/en-test-fixtures.js";
import { executeEnEdition } from "../../tools/en-edition.js";
import { setKeychainReader } from "../voice/elevenlabs.js";

let env: Env | null = null;
afterEach(async () => { await env?.cleanup(); env = null; });

const master = (id: string, extra: Record<string, unknown> = {}, name = "a-无字幕.mp4") =>
  put(path.join(env!.chatcut, name), `m-${name}-${JSON.stringify(extra)}`).then((p) => record(env!, { content_id: id, kind: "clean_master", path: p, request_id: `m-${name.replace(/[^A-Za-z0-9.]/g, "_")}`, captions_off: true, ...extra }));

describe("record kind=clean_master 核验", () => {
  it("合格：绑审过的成片 sha，落在 04-edit/无字幕母版，带声明；对账不把它当又一版成片", async () => {
    const s = await enSourceVideo(["douyin"], undefined, { master: false });
    env = s.env;
    const r = await master(s.id);
    expect(r).toMatchObject({ ok: true, kind: "clean_master", state: "accepted" });
    expect(String(r.path)).toMatch(/^04-edit\/无字幕母版\//);
    const doc = (await readProductionDoc(s.id, env.dir))!;
    const cut = doc.facts.find((f) => f.kind === "cut")!;
    expect(doc.facts.find((f) => f.kind === "clean_master")).toMatchObject({ for_cut: cut.sha256, captions_off: true, duration_ms: 12_000 });
    await reconcileContent(s.id, env.dir);
    expect((await readProductionDoc(s.id, env.dir))!.facts.filter((f) => f.kind === "cut")).toHaveLength(1);
  });

  it("不带 captions_off=true 拒；captions_off 用在别的 kind 上也拒", async () => {
    const s = await enSourceVideo(["douyin"], undefined, { master: false });
    env = s.env;
    expect(await master(s.id, { captions_off: false })).toMatchObject({ ok: false, code: "captions_off_required" });
    expect(await record(env, { content_id: s.id, kind: "srt", path: "x.srt", request_id: "x", captions_off: true })).toMatchObject({ ok: false, code: "bad_param" });
  });

  it("尺寸不对 / 没音轨 / 时长差超过半秒：拒，什么都不写", async () => {
    const s = await enSourceVideo(["douyin"], undefined, { master: false });
    env = s.env;
    const set = (info: Record<string, unknown>) => setProductionDeps({ probe: async () => ({ durationMs: 12_000, width: 1920, height: 1080, audio: true, ...info }) as never });
    set({ width: 1080, height: 1920 });
    expect(await master(s.id, {}, "a.mp4")).toMatchObject({ ok: false, code: "master_invalid", error: expect.stringContaining("1080×1920") });
    set({ audio: false });
    expect(await master(s.id, {}, "b.mp4")).toMatchObject({ ok: false, code: "master_invalid", error: expect.stringContaining("音轨") });
    set({ durationMs: 12_600 });
    expect(await master(s.id, {}, "c.mp4")).toMatchObject({ ok: false, code: "master_invalid", error: expect.stringContaining("差了 0.60 秒") });
    set({ durationMs: 12_400 });
    expect(await master(s.id, {}, "d.mp4")).toMatchObject({ ok: true });
    expect((await readProductionDoc(s.id, env.dir))!.facts.filter((f) => f.kind === "clean_master")).toHaveLength(1);
  });

  it("审过的成片没记时长（对账自己收进来的）：现量成片时长再比，照样登记得上", async () => {
    const s = await enSourceVideo(["douyin"], undefined, { master: false });
    env = s.env;
    await mutateProduction(s.id, env.dir, (d) => { for (const f of d.facts) if (f.kind === "cut") delete f.duration_ms; return { value: null, events: [] }; });
    const seen: string[] = [];
    setProductionDeps({ probe: async (file) => { seen.push(file); return { durationMs: 12_000, width: 1920, height: 1080, audio: true }; } });
    expect(await master(s.id)).toMatchObject({ ok: true });
    expect(seen.some((f) => f.includes("04-edit") && !f.includes("无字幕"))).toBe(true);
  });

  it("for_cut 不是审过的那版：拒", async () => {
    const s = await enSourceVideo(["douyin"], undefined, { master: false });
    env = s.env;
    expect(await master(s.id, { for_cut: "fact-nope" })).toMatchObject({ ok: false, code: "cut_not_approved" });
  });
});

describe("英文版的画面来源", () => {
  async function enEdition(withMaster: boolean) {
    const s = await enSourceVideo(["douyin", "youtube"], undefined, { master: withMaster });
    env = s.env;
    process.env.ELEVENLABS_API_KEY = "sk-test-secret";
    process.env.ELEVENLABS_VOICE_ID = "voice-123";
    setKeychainReader(async () => null);
    const id = String((await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: s.id })).content_id);
    await executeEnEdition({ _dataDir: env.dir, content_id: id, op: "set_script", segments: SEGMENTS });
    expect(await approveEnScript(env, id)).toMatchObject({ ok: true });
    return { src: s.id, id };
  }

  it("没登记无字幕母版：dub 拒、不调 ElevenLabs，next_action 指路 record kind=clean_master；status 里写明缺什么", async () => {
    const { src, id } = await enEdition(false);
    const calls = fakeElevenLabs([3, 3, 5]);
    const r = await executeEnEdition({ _dataDir: env!.dir, content_id: id, op: "dub" });
    expect(r).toMatchObject({ ok: false, code: "no_clean_master" });
    expect(String(r.next_action)).toContain(`record kind=clean_master content_id=${src} captions_off=true`);
    expect(calls).toEqual([]);
    expect(await executeEnEdition({ _dataDir: env!.dir, content_id: id, op: "status" })).toMatchObject({ picture_source: null, picture_problem: expect.stringContaining("无字幕母版") });
  });

  it("母版在对账之前被覆盖：dub 拒、不调 ElevenLabs，status 也报出来", async () => {
    const { id } = await enEdition(true);
    const calls = fakeElevenLabs([3, 3, 5]);
    const st = await executeEnEdition({ _dataDir: env!.dir, content_id: id, op: "status" });
    await fs.writeFile(String(st.picture_source), "overwritten-bytes");
    const r = await executeEnEdition({ _dataDir: env!.dir, content_id: id, op: "dub" });
    expect(r).toMatchObject({ ok: false, code: "no_clean_master", error: expect.stringContaining("被改过") });
    expect(calls).toEqual([]);
    expect(await executeEnEdition({ _dataDir: env!.dir, content_id: id, op: "status" })).toMatchObject({ picture_source: null });
  });

  it("登记了：dub 回执带 picture_source（母版的绝对路径），status 也给出", async () => {
    const { id } = await enEdition(true);
    fakeElevenLabs([3, 3, 5]);
    const r = await executeEnEdition({ _dataDir: env!.dir, content_id: id, op: "dub" });
    expect(r).toMatchObject({ ok: true, picture_source: { path: expect.stringMatching(/04-edit\/无字幕母版\/深度思考-无字幕\.mp4$/), duration_s: 12 } });
    expect((await executeEnEdition({ _dataDir: env!.dir, content_id: id, op: "status" })).picture_source).toMatch(/无字幕\.mp4$/);
  });
});
