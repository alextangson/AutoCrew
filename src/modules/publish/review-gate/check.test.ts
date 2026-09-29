/**
 * 发布前把关 `autocrew_publish check`（spec 2026-09-29-publish-review-gate §15 验收、§13 边界）。
 * 用内容本体的临时资料库（layout v2）造一条「认稿 → 报成片 / 字幕 / 封面 → 批准即登记」的视频；Jev 一律注入假调用器，不连网。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../../storage/local-store.js";
import { readProductionDoc } from "../../../storage/production-store.js";
import { founderDecision } from "../../production/decisions.js";
import { registeredPackage } from "../../production/publish-gate.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, videoContent, type Env } from "../../production/testkit.js";
import { executePublish } from "../../../tools/publish.js";
import { executePublishCheck } from "./check.js";
import { JevError, type JevAnswer, type JevCaller, type JevQuestion } from "./jev-client.js";
import { saveInstruction } from "./instructions.js";
import { addPublishRule } from "./preferences.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const TITLE = "AI 又忘了怎么办";
const SRT_TEXT = "1\n00:00:00,000 --> 00:00:05,000\nAI 老是忘事，我试了 3 个办法\n\n2\n00:00:05,000 --> 00:00:10,000\n第一个办法是把规则写进文件\n";

/** 认过稿、报齐、两道批准 → 自动登记；回项目内的登记成片 / 封面相对路径 */
async function registered(coverText = "AI 又忘了？") {
  const c = await videoContent(env, TITLE);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
  const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "AI又忘了怎么办.mp4"), "cut-v1"), request_id: "c" });
  await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "a.srt"), SRT_TEXT), for_cut: cut.fact_id, request_id: "s" });
  const c34 = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c34.png"), png(900, 1200)), request_id: "p1" });
  const c43 = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c43.png"), png(1200, 900)), version: 1, request_id: "p2" });
  const doc = (await readProductionDoc(c.id, env.dir))!;
  const sha = (id: unknown) => doc.facts.find((f) => f.id === id)!.sha256!;
  await founderDecision(c.id, "approve_cut", { fact_id: cut.fact_id, sha256: sha(cut.fact_id) }, env.dir);
  const picked = await founderDecision(c.id, "pick_cover", { cover_3x4_fact_id: c34.fact_id, cover_3x4_sha: sha(c34.fact_id), cover_4x3_fact_id: c43.fact_id, cover_4x3_sha: sha(c43.fact_id), cover_text: coverText }, env.dir);
  expect(picked).toMatchObject({ ok: true });
  const gate = await registeredPackage((await getContent(c.id, env.dir))!, env.dir);
  if (!gate?.ok) throw new Error(`没登记上：${JSON.stringify(gate)}`);
  const root = projectRoot(env, c.id);
  const rel = (p: string) => path.relative(root, p);
  return { id: c.id, root, video: rel(gate.files.video), c34: rel(gate.files.cover34), c43: rel(gate.files.cover43) };
}

type Reg = Awaited<ReturnType<typeof registered>>;
const CAPTION = "AI 总忘事？这期讲我试过的办法，看完就能用上。#AI工具";

function entry(r: Reg, platform: string, covers: Array<"3:4" | "4:3">, extra: Record<string, unknown> = {}) {
  return { platform, content_id: r.id, account_display_name: "哈姆雷鹿", title: "AI 老忘事的办法", caption: CAPTION, cover_text: "AI 又忘了？",
    covers: covers.map((ratio) => ({ usage: ratio === "3:4" ? "竖版封面" : "横版封面", ratio, path: ratio === "3:4" ? r.c34 : r.c43 })), ...extra };
}
const plan = (r: Reg, platforms: unknown[]) => ({ final_video: { path: r.video }, platforms });

/** 假 Jev：全部「没问题」；记下每次请求 */
function fakeJev(overrides: (id: string, q: JevQuestion) => JevAnswer | undefined = () => undefined) {
  const calls: Array<{ state: unknown; questions: Record<string, JevQuestion> }> = [];
  const caller: JevCaller = async (state, questions) => {
    calls.push({ state, questions });
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      const forced = overrides(id, q);
      if (forced) { answers[id] = forced; continue; }
      if (q.type === "noul") answers[id] = { type: "noul", noul: id.startsWith("v") ? 0.05 : 0.9 };
      else {
        const pickKey = id === "a1" ? "准确" : id === "a3" ? "讲清问题或答案" : "不约束发布内容";
        answers[id] = { type: "choice", choice: pickKey, probabilities: { [pickKey]: 0.9 }, confidence: 0.8 };
      }
    }
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 400, output_tokens: 20 }, ms: 5 };
  };
  return { caller, calls };
}

type Out = { ok: boolean; platforms: Array<{ platform: string; verdict: string; check_id: string; payload_hash: string; fingerprint: string; items: Array<Record<string, unknown>> }>; summary_table: string; semantic: { status: string } };
async function check(params: Record<string, unknown>, jev: JevCaller): Promise<Out> {
  return (await executePublishCheck({ _dataDir: env.dir, ...params }, { jev })) as unknown as Out;
}
const byPlatform = (o: Out, p: string) => o.platforms.find((x) => x.platform === p)!;
const blockedRules = (o: Out, p: string) => byPlatform(o, p).items.filter((i) => i.result === "block").map((i) => i.rule);

describe("确定性：封面上传槽（§3、§5）", () => {
  it("小红书 4:3 → block；视频号只 3:4 → block；抖音 3:4+4:3 → pass；B站 4:3 → pass 且汇总含「16:9 裁切核对」", async () => {
    const r = await registered();
    const { caller } = fakeJev();
    const out = await check({ content_id: r.id, plan: plan(r, [entry(r, "xiaohongshu", ["4:3"]), entry(r, "wechat_video", ["3:4"]), entry(r, "douyin", ["3:4", "4:3"]), entry(r, "bilibili", ["4:3"])]) }, caller);
    expect(out.ok).toBe(true);
    expect(byPlatform(out, "xiaohongshu").verdict).toBe("block");
    expect(blockedRules(out, "xiaohongshu")).toEqual(expect.arrayContaining(["cover_extra_ratio", "cover_ratio"]));
    expect(byPlatform(out, "wechat_video").verdict).toBe("block");
    expect(blockedRules(out, "wechat_video")).toEqual(["cover_ratio"]);
    expect(byPlatform(out, "douyin").verdict).toBe("pass");
    expect(byPlatform(out, "bilibili").verdict).toBe("pass");
    expect(out.summary_table).toContain("16:9 裁切核对");
    expect(out.summary_table).toMatch(/\| 平台 \| 账号 \| 封面文件 \| 比例 \| 用途槽 \| 是否符合 \| 例外 \| 其他提醒 \|/);
  });

  it("账号资料的 coverRatios 覆盖默认表（小红书改 3:4+4:3 后，只传 3:4 就缺槽）", async () => {
    const r = await registered();
    const { mutateProfile } = await import("../../profile/creator-profile.js");
    await mutateProfile((p) => { p.coverRatios = { xiaohongshu: ["3:4", "4:3"] }; }, env.dir);
    const out = await check({ content_id: r.id, plan: plan(r, [entry(r, "xiaohongshu", ["3:4"])]) }, fakeJev().caller);
    expect(blockedRules(out, "xiaohongshu")).toEqual(["cover_ratio"]);
  });

  it("旧 cover_path 视作单张按像素判", async () => {
    const r = await registered();
    const legacy = { ...entry(r, "xiaohongshu", []), covers: undefined, cover_path: r.c43 };
    const out = await check({ content_id: r.id, plan: plan(r, [legacy]) }, fakeJev().caller);
    expect(blockedRules(out, "xiaohongshu")).toEqual(expect.arrayContaining(["cover_extra_ratio", "cover_ratio"]));
  });
});

describe("确定性：登记身份、封面字、字数、排期、归属（§5）", () => {
  it("非登记封面 / 非登记成片 → block", async () => {
    const r = await registered();
    await put(path.join(r.root, "05-cover/other-3x4.png"), png(900, 1200, "other"));
    await put(path.join(r.root, "07-delivery/other.mp4"), "other-cut");
    const e = { ...entry(r, "douyin", ["3:4", "4:3"]) };
    e.covers[0].path = "05-cover/other-3x4.png";
    const out = await check({ content_id: r.id, plan: { final_video: { path: "07-delivery/other.mp4" }, platforms: [e] } }, fakeJev().caller);
    expect(blockedRules(out, "douyin")).toEqual(expect.arrayContaining(["cover_registered", "cut_registered"]));
  });

  it("封面字不等 → block；登记有字而计划没写 → 未检查（不算通过）", async () => {
    const r = await registered();
    const out = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"], { cover_text: "别的字" }), entry(r, "bilibili", ["4:3"], { cover_text: null })]) }, fakeJev().caller);
    expect(blockedRules(out, "douyin")).toEqual(["cover_text"]);
    const bili = byPlatform(out, "bilibili");
    expect(bili.items.find((i) => i.check === "封面字")).toMatchObject({ result: "unchecked" });
    expect(bili.verdict).toBe("warn");
  });

  it("字数口径按平台：抖音文案不设硬上限，小红书 1000 上限；标题按加权计数", async () => {
    const r = await registered();
    const long = `${"很长的文案".repeat(260)}#AI工具`;
    const out = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"], { caption: long }), entry(r, "xiaohongshu", ["3:4"], { caption: long, title: "一".repeat(21) })]) }, fakeJev().caller);
    expect(blockedRules(out, "douyin")).toEqual([]);
    expect(blockedRules(out, "xiaohongshu")).toEqual(expect.arrayContaining(["caption_limit", "title_limit"]));
    const detail = byPlatform(out, "xiaohongshu").items.find((i) => i.rule === "caption_limit")!.basis as string;
    expect(detail).toMatch(/字符串长度.*上限 1000/);
  });

  it("排期没带时区 → block；带 timezone 或 +08:00 → 过", async () => {
    const r = await registered();
    const out = await check({ content_id: r.id, plan: plan(r, [
      entry(r, "douyin", ["3:4", "4:3"], { scheduled_at: "2026-10-01T20:00:00" }),
      entry(r, "bilibili", ["4:3"], { scheduled_at: "2026-10-01T20:00:00", timezone: "Asia/Shanghai" }),
      entry(r, "wechat_video", ["3:4", "4:3"], { scheduled_at: "2026-10-01T20:00:00+08:00" }),
    ]) }, fakeJev().caller);
    expect(blockedRules(out, "douyin")).toEqual(["schedule_tz"]);
    expect(blockedRules(out, "bilibili")).toEqual([]);
    expect(blockedRules(out, "wechat_video")).toEqual([]);
  });

  it("跨内容的 content_id / 项目外路径 → block（E13）；文件缺失 → block 且不能例外", async () => {
    const r = await registered();
    const other = await videoContent(env, "别的稿");
    const out = await check({ content_id: r.id, overrides: [{ platform: "bilibili", rule: "file_missing", founder_quote: "照发" }], plan: plan(r, [
      entry(r, "douyin", ["3:4", "4:3"], { content_id: other.id }),
      { ...entry(r, "bilibili", ["4:3"]), covers: [{ usage: "横版", ratio: "4:3", path: "05-cover/nope.png" }] },
      { ...entry(r, "xiaohongshu", ["3:4"]), covers: [{ usage: "竖版", ratio: "3:4", path: "/etc/hosts" }] },
    ]) }, fakeJev().caller);
    expect(blockedRules(out, "douyin")).toEqual(["ownership"]);
    expect(blockedRules(out, "bilibili")).toContain("file_missing");
    expect(byPlatform(out, "bilibili").items.find((i) => i.check === "例外")!.basis).toMatch(/不能例外/);
    expect(blockedRules(out, "xiaohongshu")).toContain("ownership");
  });

  it("计划形状不对 → block 并指出字段（E12）；一个平台被拦不影响其他（E1）", async () => {
    const r = await registered();
    const out = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"]), { ...entry(r, "douyin", ["3:4"]) }, { platform: "快手" }, { ...entry(r, "bilibili", ["4:3"]), tags: "不是数组" }]) }, fakeJev().caller);
    expect(blockedRules(out, "douyin")).toEqual(["plan_shape"]);
    expect(blockedRules(out, "bilibili")).toEqual(["plan_shape"]);
    expect(out.summary_table).toContain("认不出平台");
    const empty = await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: { platforms: [] } }, { jev: fakeJev().caller }) as { error: string };
    expect(empty.error).toContain("计划里没有平台");
    expect(await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: "../../etc/passwd" }, { jev: fakeJev().caller })).toMatchObject({ ok: false, code: "plan_outside_project" });
  });

  it("check 只写留档，不改业务状态；留档里没有密钥", async () => {
    const r = await registered();
    const before = await getContent(r.id, env.dir);
    const docBefore = await readProductionDoc(r.id, env.dir);
    process.env.TYPESAFE_API_KEY = "sk-test-should-not-leak";
    try {
      const out = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"])]) }, fakeJev().caller);
      expect((await getContent(r.id, env.dir))!.status).toBe(before!.status);
      expect(await readProductionDoc(r.id, env.dir)).toEqual(docBefore);
      const rec = await fs.readFile(path.join(r.root, "06-publish/checks", `${byPlatform(out, "douyin").check_id}.json`), "utf8");
      expect(rec).not.toContain("sk-test-should-not-leak");
      expect(JSON.parse(rec)).toMatchObject({ platform: "douyin", verdict: "pass", fingerprint_parts: { model: "jev-1.13.0" }, jev: { calls: [{ kind: "A", usage: { input_tokens: 400 } }] } }); // 没有原话 / 规则 → 不调 B
    } finally { delete process.env.TYPESAFE_API_KEY; }
  });
});

describe("平台集合与例外（§4、§7）", () => {
  it("原话点名的平台计划里没有 → 漏平台 block；多出的平台提醒", async () => {
    const r = await registered();
    const out = await check({ content_id: r.id, founder_quotes: ["发抖音和小红书"], plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"]), entry(r, "bilibili", ["4:3"])]) }, fakeJev().caller);
    expect(byPlatform(out, "xiaohongshu")).toMatchObject({ verdict: "block" });
    expect(blockedRules(out, "xiaohongshu")).toEqual(["platform_missing"]);
    expect(byPlatform(out, "bilibili").items.some((i) => i.check === "平台集合" && i.result === "warn")).toBe(true);
  });

  it("带原话例外 → override（不是 pass），汇总逐字可见；Jev 顺带核对原话像不像在说这条", async () => {
    const r = await registered();
    const quote = "小红书这次就用横版封面，别管规则";
    const { caller } = fakeJev((id) => (id.startsWith("o") ? { type: "noul", noul: 0.2 } : undefined));
    const out = await check({ content_id: r.id, founder_quotes: [quote], overrides: [{ platform: "小红书", rule: "cover_extra_ratio", founder_quote: quote }, { platform: "xiaohongshu", rule: "cover_ratio", founder_quote: quote }], plan: plan(r, [entry(r, "xiaohongshu", ["4:3"])]) }, caller);
    const xhs = byPlatform(out, "xiaohongshu");
    expect(xhs.verdict).toBe("override");
    expect(xhs.items.filter((i) => i.result === "override").map((i) => i.rule).sort()).toEqual(["cover_extra_ratio", "cover_ratio"]);
    expect(out.summary_table).toContain(`按你原话例外：『${quote}』`);
    expect(xhs.items.some((i) => i.check === "例外原话核对" && i.result === "warn" && String(i.basis).includes("不像在说这条例外"))).toBe(true);
  });

  it("overrides 传成 JSON 字符串也认；形状不对明确拒", async () => {
    const r = await registered();
    const out = await check({ content_id: r.id, overrides: JSON.stringify([{ platform: "douyin", rule: "cover_text", founder_quote: "字不一样没事" }]), plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"], { cover_text: "别的" })]) }, fakeJev().caller);
    expect(byPlatform(out, "douyin").verdict).toBe("override");
    expect(await executePublishCheck({ _dataDir: env.dir, content_id: r.id, overrides: [{ platform: "douyin" }], plan: plan(r, []) }, { jev: fakeJev().caller })).toMatchObject({ ok: false, code: "bad_overrides" });
  });
});

describe("检查身份与缓存（§2.1、E2、E3、E11）", () => {
  it("改一个平台只让它失效：另一个平台指纹不变、Jev 不重调", async () => {
    const r = await registered();
    const jev = fakeJev();
    const first = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"]), entry(r, "bilibili", ["4:3"])]) }, jev.caller);
    const callsAfterFirst = jev.calls.length;
    const second = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"], { title: "换个标题" }), entry(r, "bilibili", ["4:3"])]) }, jev.caller);
    expect(byPlatform(second, "bilibili").fingerprint).toBe(byPlatform(first, "bilibili").fingerprint);
    expect(byPlatform(second, "douyin").fingerprint).not.toBe(byPlatform(first, "douyin").fingerprint);
    expect(byPlatform(second, "douyin").payload_hash).not.toBe(byPlatform(first, "douyin").payload_hash);
    expect(jev.calls.length - callsAfterFirst).toBe(1); // 只有抖音的 A 重跑（没有原话，不调 B）
  });

  it("写回执 / 授权等过程字段不让检查失效", async () => {
    const r = await registered();
    const jev = fakeJev();
    const a = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"])]) }, jev.caller);
    const b = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"], { publication: { status: "published", public_url: "https://x" }, authorization: { user_message: "发吧" } })]) }, jev.caller);
    expect(byPlatform(b, "douyin").payload_hash).toBe(byPlatform(a, "douyin").payload_hash);
    expect(byPlatform(b, "douyin").fingerprint).toBe(byPlatform(a, "douyin").fingerprint);
  });

  it("原路径文件被覆盖 → 指纹变、重检（且不再是登记的那一份）", async () => {
    const r = await registered();
    const jev = fakeJev();
    const a = await check({ content_id: r.id, plan: plan(r, [entry(r, "bilibili", ["4:3"])]) }, jev.caller);
    const t = new Date(Date.now() + 5_000);
    await fs.writeFile(path.join(r.root, r.c43), png(1200, 900, "overwritten"));
    await fs.utimes(path.join(r.root, r.c43), t, t);
    const b = await check({ content_id: r.id, plan: plan(r, [entry(r, "bilibili", ["4:3"])]) }, jev.caller);
    expect(byPlatform(b, "bilibili").payload_hash).not.toBe(byPlatform(a, "bilibili").payload_hash);
    expect(byPlatform(b, "bilibili").verdict).toBe("block");
  });

  it("Jev 没跑成：确定性照跑，语义标「没跑成+原因」，不挡、不缓存；下次重试", async () => {
    const r = await registered();
    const failing: JevCaller = async () => { throw new JevError("没配 TypeSafe 密钥（环境变量 TYPESAFE_API_KEY 或设置页）"); };
    const p = { content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"])]) };
    const a = await check(p, failing);
    const douyin = byPlatform(a, "douyin");
    expect(douyin.verdict).toBe("warn");
    expect(douyin.items.filter((i) => i.result === "block")).toEqual([]);
    expect(douyin.items.some((i) => i.result === "not_run" && String(i.basis).includes("没配 TypeSafe 密钥"))).toBe(true);
    expect(a.semantic.status).toBe("not_run");
    expect(a.summary_table).toContain("没跑成");
    const jev = fakeJev();
    const b = await check(p, jev.caller);
    expect(jev.calls.length).toBe(1); // 失败那次没缓存，这次真的重调了
    expect(byPlatform(b, "douyin").verdict).toBe("pass");
  });

  it("同指纹并发调用合并成一次，不重复计费", async () => {
    const r = await registered();
    const jev = fakeJev();
    const p = { content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"])]) };
    await Promise.all([check(p, jev.caller), check(p, jev.caller)]);
    expect(jev.calls.length).toBe(1); // 两个并发调用只打了一次 A
  });
});

describe("Jev A / B 与指令来源（§6、§8、§9）", () => {
  it("A2：字幕里逐字出现的数字由代码直接判；字幕里没有的交给 Jev，不支持 → 提醒", async () => {
    const r = await registered();
    const jev = fakeJev((id) => (id.startsWith("a2_") ? { type: "noul", noul: 0.1 } : undefined));
    const out = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"], { title: "我试了 3 个办法，效率提升 80%" })]) }, jev.caller);
    const items = byPlatform(out, "douyin").items;
    expect(items.some((i) => i.check === "A2 说法有据" && i.result === "pass" && String(i.basis).includes("代码直接判"))).toBe(true);
    expect(items.some((i) => i.check === "A2 说法有据" && i.result === "warn" && String(i.basis).includes("80%"))).toBe(true);
    const aState = jev.calls[0].state as { subtitles: string };
    expect(aState.subtitles).toContain("把规则写进文件");
  });

  it("B：违反原话的字段 → 提醒，带指令原文与字段；没有任何原话 / 规则 → 不算失败", async () => {
    const r = await registered();
    const jev = fakeJev((id) => {
      if (id === "s1") return { type: "choice", choice: "封面", probabilities: { 封面: 0.9 }, confidence: 0.9 };
      if (id === "v1_5") return { type: "noul", noul: 0.96 };
      return undefined;
    });
    const out = await check({ content_id: r.id, founder_quotes: ["小红书的封面用 3:4 的"], plan: plan(r, [entry(r, "xiaohongshu", ["3:4"])]) }, jev.caller);
    const hit = byPlatform(out, "xiaohongshu").items.find((i) => i.check === "B 执行符合指令" && i.result === "warn")!;
    expect(hit).toMatchObject({ field: "封面" });
    expect(String(hit.basis)).toContain("小红书的封面用 3:4 的");
    const none = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"])]) }, fakeJev().caller);
    expect(byPlatform(none, "douyin").items.find((i) => String(i.basis).includes("没有可核对的原话"))).toMatchObject({ result: "info" });
  });

  it("instruction_id：只用传来的那份；不传不取「最近一份」；传错编号明确拒", async () => {
    const r = await registered();
    const saved = await saveInstruction(r.id, "发布这条视频。\n平台：抖音、B站", "copy_open", env.dir);
    if (!saved.ok) throw new Error(saved.error);
    const jev = fakeJev();
    const without = await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"])]) }, jev.caller);
    expect(byPlatform(without, "douyin").items.some((i) => String(i.basis).includes("没有可核对的原话"))).toBe(true);
    expect(without.platforms.map((p) => p.platform)).toEqual(["douyin"]); // 没用指令里的「B站」去判漏平台
    const withIns = await check({ content_id: r.id, instruction_id: saved.instruction.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"])]) }, fakeJev().caller);
    expect(blockedRules(withIns, "bilibili")).toEqual(["platform_missing"]);
    expect(await executePublishCheck({ _dataDir: env.dir, content_id: r.id, instruction_id: "ins-20260101000000-abcdef", plan: plan(r, []) }, { jev: jev.caller })).toMatchObject({ ok: false, code: "instruction_not_found" });
  });

  it("适用的 publishRules 进 B 的指令列表（只收本平台或全平台的）", async () => {
    const r = await registered();
    await addPublishRule("B站标题不要带表情", "bilibili", env.dir);
    await addPublishRule("所有平台都带 #AI工具", undefined, env.dir);
    const jev = fakeJev();
    await check({ content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"])]) }, jev.caller);
    const b = jev.calls.find((c) => Object.keys(c.questions).some((k) => k.startsWith("s")))!;
    const texts = Object.values(b.questions).map((q) => JSON.stringify(q.instructions));
    expect(texts.some((t) => t.includes("所有平台都带"))).toBe(true);
    expect(texts.some((t) => t.includes("B站标题不要带表情"))).toBe(false);
  });
});

describe("没按本体登记的稿（E9）与工具入口", () => {
  it("登记身份未核对（不算通过）；A 用定稿正文比对并写明", async () => {
    const plainEnv = await makeEnv({ enabled: false });
    try {
      const c = await videoContent(plainEnv, "旧流程的稿", "draft_ready", "旧流程的定稿正文，讲了三件事。");
      const root = projectRoot(plainEnv, c.id);
      await put(path.join(root, "07-delivery/final.mp4"), "cut");
      await put(path.join(root, "05-cover/a.png"), png(1200, 900));
      const jev = fakeJev();
      const out = (await executePublishCheck({ _dataDir: plainEnv.dir, content_id: c.id, plan: { final_video: { path: "07-delivery/final.mp4" }, platforms: [{ platform: "bilibili", content_id: c.id, title: "旧流程的稿", caption: CAPTION, covers: [{ usage: "横版", ratio: "4:3", path: "05-cover/a.png" }] }] } }, { jev: jev.caller })) as unknown as Out;
      const items = byPlatform(out, "bilibili").items;
      expect(items.find((i) => i.check === "登记身份")).toMatchObject({ result: "unchecked" });
      expect(items.find((i) => i.check === "A1 标题文案与视频一致")!.basis).toContain("没有登记字幕，用定稿正文比对");
      expect((jev.calls[0].state as { subtitles: string }).subtitles).toContain("讲了三件事");
    } finally { await plainEnv.cleanup(); }
  });

  it("autocrew_publish check 不被旧预检中间件挡、不推状态；propose_preference 只记提议", async () => {
    const r = await registered();
    const out = await executePublish({ _dataDir: env.dir, action: "check", content_id: r.id, plan: plan(r, [entry(r, "douyin", ["3:4", "4:3"])]) }, { check: { jev: fakeJev().caller } });
    expect(out).toMatchObject({ ok: true, content_id: r.id });
    const proposed = await executePublish({ _dataDir: env.dir, _host: "codex", action: "propose_preference", kind: "cover_ratio", platform: "小红书", value: "3:4,4:3", founder_quote: "小红书以后横竖都传" });
    expect(proposed).toMatchObject({ ok: true, proposal: { kind: "cover_ratio", platform: "xiaohongshu", value: ["3:4", "4:3"], status: "pending", host: "codex" } });
    const still = await check({ content_id: r.id, plan: plan(r, [entry(r, "xiaohongshu", ["3:4"])]) }, fakeJev().caller);
    expect(blockedRules(still, "xiaohongshu")).toEqual([]); // 提议没确认前照旧按 3:4 判
  });
});
