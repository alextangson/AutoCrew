/** Codex 审查（2026-09-29 codex-review-build）每条发现一个回归测试 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeEnv, type Env } from "../../production/testkit.js";
import { executePublishCheck } from "./check.js";
import { makeJevCaller, parseJevBody, type JevQuestion } from "./jev-client.js";
import { buildBenchSet, runBench } from "./bench.js";
import { basisFromDraft } from "./subtitles.js";
import { readOverrides, readQuotes } from "./inputs.js";
import { loadPlan } from "./plan.js";
import { fakeJev, planEntry, planOf, registeredVideo } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

type P = { platform: string; verdict: string; payload_hash: string; fingerprint: string; items: Array<Record<string, unknown>> };
const run = async (params: Record<string, unknown>, jev = fakeJev().caller) => (await executePublishCheck({ _dataDir: env.dir, ...params }, { jev })) as Record<string, unknown>;
const platformOf = (out: Record<string, unknown>, p: string) => (out.platforms as P[]).find((x) => x.platform === p)!;

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p))); else out.push(p);
  }
  return out;
}

describe("[P1] 密钥不外泄", () => {
  it("fetch 异常文字里带着密钥、URL、请求体：返回、留档、缓存、日志、评测结果里都没有", async () => {
    const r = await registeredVideo(env);
    const FAKE = "sk-FAKE-LEAK-0123456789";
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = FAKE;
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
    try {
      const fetchImpl = (async (url: string, init: RequestInit) => {
        throw new TypeError(`Headers.append: "Authorization: ${(init.headers as Record<string, string>).Authorization}" invalid; url=${url}; body=${String(init.body).slice(0, 40)}`);
      }) as unknown as typeof fetch;
      const jev = makeJevCaller({ fetchImpl });
      const out = await run({ content_id: r.id, founder_quotes: ["发抖音"], plan: planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])]) }, jev);
      const text = JSON.stringify(out);
      expect(text).not.toContain(FAKE);
      expect(text).not.toContain("api.typesafe.ai");
      expect(text).toContain("连不上 TypeSafe（网络错误）");
      const files = await allFiles(path.join(r.root, "06-publish"));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) expect(await fs.readFile(f, "utf8")).not.toContain(FAKE);
      const video = { id: "v", title: "t", basis: basisFromDraft("正文。说了三件事。"), entries: [{ platform: "douyin", label: "抖音", title: "t", caption: "c" }] };
      expect(JSON.stringify(await runBench(buildBenchSet([video]), [video], jev))).not.toContain(FAKE);
      expect(logs.join("\n")).not.toContain(FAKE);
    } finally {
      spies.forEach((s) => s.mockRestore());
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it("带换行 / 空白的密钥根本不发请求", async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "sk-FAKE\nLEAK-0123456789";
    let sent = false;
    try {
      const call = makeJevCaller({ fetchImpl: (async () => { sent = true; throw new Error("x"); }) as unknown as typeof fetch });
      await expect(call({}, {})).rejects.toMatchObject({ reason: expect.stringMatching(/格式不对/) });
      expect(sent).toBe(false);
    } finally { if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved; }
  });
});

describe("[复审] 响应只按白名单重建", () => {
  it("响应里的额外字段（含假密钥）、多出来的答案、怪模型名都进不了返回与留档", async () => {
    const r = await registeredVideo(env);
    const FAKE = "sk-FAKE-IN-RESPONSE-987654";
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "k-test-12345678";
    const respond = (model: string) => (async (_u: string, init: RequestInit) => {
      const { questions } = JSON.parse(String(init.body)) as { questions: Record<string, JevQuestion> };
      const answers: Record<string, unknown> = { zz_extra: { type: "noul", noul: 0.5, note: FAKE } };
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: id.startsWith("v") ? 0.05 : 0.9, note: FAKE };
        else { const k = Object.keys(q.criteria)[0]; answers[id] = { type: "choice", choice: k, probabilities: { [k]: 1 }, confidence: 0.9, rationale: FAKE }; }
      }
      return new Response(JSON.stringify({ model, answers, usage: { input_tokens: 10, output_tokens: 1, trace: FAKE }, debug: { echo: FAKE } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const out = await run({ content_id: r.id, founder_quotes: ["发抖音"], plan: planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])]) }, makeJevCaller({ fetchImpl: respond("jev-1.13.0") }));
      expect(JSON.stringify(out)).not.toContain(FAKE);
      expect(JSON.stringify(out)).not.toContain("zz_extra");
      for (const f of await allFiles(path.join(r.root, "06-publish"))) {
        const text = await fs.readFile(f, "utf8");
        expect(text).not.toContain(FAKE);
        expect(text).not.toContain("zz_extra");
      }
      const odd = await makeJevCaller({ fetchImpl: respond(FAKE) })({}, { n: { type: "noul", instructions: "?" } }).catch((e) => e);
      expect(odd.reason).toMatch(/模型标识不认识/);
      expect(JSON.stringify(odd.reason)).not.toContain(FAKE);
    } finally { if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved; }
  });
});

describe("[P1] 指纹覆盖 Jev B 的全部输入", () => {
  it("原话「不要参加任何活动」，只加一个选中的活动：指纹变、重问 Jev（payload_hash 不变）", async () => {
    const r = await registeredVideo(env);
    const jev = fakeJev();
    const quotes = ["不要参加任何活动"];
    const a = await run({ content_id: r.id, founder_quotes: quotes, plan: planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])]) }, jev.caller);
    const n = jev.calls.length;
    const b = await run({ content_id: r.id, founder_quotes: quotes, plan: planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"], { campaigns: [{ name: "谁AI上班", selected: true }] })]) }, jev.caller);
    expect(platformOf(b, "douyin").payload_hash).toBe(platformOf(a, "douyin").payload_hash);
    expect(platformOf(b, "douyin").fingerprint).not.toBe(platformOf(a, "douyin").fingerprint);
    expect(jev.calls.length).toBeGreaterThan(n);
    expect(JSON.stringify(jev.calls.at(-1)!.state)).toContain("谁AI上班");
  });
});

describe("[P2] 系统边界上的参数不静默丢", () => {
  it("campaigns 传成 JSON 字符串照样进 Jev B；解析不了报形状错误", async () => {
    const r = await registeredVideo(env);
    const jev = fakeJev();
    await run({ content_id: r.id, founder_quotes: ["不要参加任何活动"], plan: planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"], { campaigns: JSON.stringify([{ name: "谁AI上班", selected: true }]) })]) }, jev.caller);
    expect(JSON.stringify(jev.calls.at(-1)!.state)).toContain("谁AI上班");
    const bad = await run({ content_id: r.id, plan: planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"], { campaigns: "[{name: 坏的" })]) });
    expect(platformOf(bad, "douyin").items.find((i) => i.field === "campaigns")).toMatchObject({ result: "block", rule: "plan_shape" });
  });

  it("没转义的内部双引号：修过再解析；修不好的结构化参数明确报错，不当成一条原话", async () => {
    expect(readQuotes('["他说"用 3:4"就行", "发抖音"]')).toEqual({ ok: true, value: ['他说"用 3:4"就行', "发抖音"] });
    expect(readQuotes('["没闭合')).toMatchObject({ ok: false, code: "bad_founder_quotes" });
    expect(readOverrides('[{"platform":"douyin","rule":"cover_text","founder_quote":"就用"这个"字"}]')).toMatchObject({ ok: true, value: [{ founder_quote: '就用"这个"字' }] });
    const r = await registeredVideo(env);
    const plan = JSON.stringify(planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])])).replace('"AI 老忘事的办法"', '"AI "老忘事"的办法"');
    const loaded = await loadPlan(plan, r.root);
    expect(loaded).toMatchObject({ ok: true });
    expect(JSON.stringify(loaded)).toContain('AI \\"老忘事\\"的办法');
    expect(await loadPlan("{ platforms: [", r.root)).toMatchObject({ ok: false, code: "plan_unreadable" });
  });

  it("计划级形状问题进结构化结果：空计划 ok:false；认不出的条目进 plan_problems 与 blocked_platforms", async () => {
    const r = await registeredVideo(env);
    expect(await run({ content_id: r.id, plan: { platforms: [] } })).toMatchObject({ ok: false, code: "plan_invalid" });
    const out = await run({ content_id: r.id, plan: planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"]), { platform: "快手" }, "不是对象"]) });
    expect(out.blocked_platforms).toContain("plan");
    expect((out.plan_problems as unknown[]).length).toBe(2);
    expect(String(out.next_action)).toContain("计划本身");
  });
});

describe("[P2] 判定正确性", () => {
  it("choice 概率表不对（空、非数字、越界、合计不为 1、缺被选项）→ 返回形状不对", () => {
    const Q: Record<string, JevQuestion> = { c: { type: "choice", instructions: "?", criteria: { 准确: null, 误导: null } } };
    const body = (probabilities: unknown) => ({ answers: { c: { type: "choice", choice: "准确", probabilities, confidence: 0.9 } }, usage: { input_tokens: 1 } });
    for (const bad of [{}, { 准确: "0.9", 误导: 0.1 }, { 准确: 1.4, 误导: -0.4 }, { 准确: 0.5, 误导: 0.1 }, { 误导: 1 }, { 准确: 0.9, 别的: 0.1 }]) {
      expect(() => parseJevBody(body(bad), Q, 1)).toThrow(/返回形状不对/);
    }
    expect(parseJevBody(body({ 准确: 0.9, 误导: 0.1 }), Q, 1).answers.c).toMatchObject({ choice: "准确" });
  });

  it("归属例外不绕过文件检查：项目外且不存在的成片仍 file_missing（不能例外）", async () => {
    const r = await registeredVideo(env);
    const out = await run({ content_id: r.id, overrides: [{ platform: "douyin", rule: "ownership", founder_quote: "放外面没事" }],
      plan: { final_video: { path: "/definitely/not/here.mp4" }, platforms: [planEntry(r, "douyin", ["3:4", "4:3"])] } });
    const d = platformOf(out, "douyin");
    expect(d.verdict).toBe("block");
    expect(d.items.find((i) => i.rule === "ownership")).toMatchObject({ result: "override" });
    expect(d.items.find((i) => i.rule === "file_missing")).toMatchObject({ result: "block", overridable: false });
  });

  it("数字说法按完整数值匹配：字幕说「73%」，标题「3%」不算逐字有据，要问 Jev", async () => {
    const r = await registeredVideo(env);
    const jev = fakeJev();
    const out = await run({ content_id: r.id, plan: planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"], { title: "效率提升 3%" })]) }, jev.caller);
    expect(platformOf(out, "douyin").items.some((i) => String(i.basis).includes("代码直接判"))).toBe(false);
    expect(Object.values(jev.calls[0].questions).some((q) => JSON.stringify(q.instructions).includes("3%"))).toBe(true);
    const whole = await run({ content_id: r.id, plan: planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"], { title: "效率提升 73%" })]) }, fakeJev().caller);
    expect(platformOf(whole, "douyin").items.some((i) => String(i.basis).includes("「73%」") && String(i.basis).includes("代码直接判"))).toBe(true);
  });
});
