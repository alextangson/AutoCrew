/**
 * verifier 2026-10-15：写稿改造（范文 / 写法 / 开头三选一 / 观众试读 / 跨稿学习）的边界补测，
 * 修复后收进仓库当回归用例（「[发现]」= 当时发现、已修的问题）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeDraft } from "./draft.js";
import { OPENINGS, pickOpening } from "./draft-test-helpers.js";
import { setQuoteFetch } from "../modules/draft/verify-quote.js";
import { updateContent } from "../storage/local-store.js";
import { updateProfile } from "../modules/profile/creator-profile.js";
import { exemplarVersionPath, putExemplar } from "../modules/exemplar/store.js";
import { decidePromotion, proposePromotion, readPromotions } from "../modules/exemplar/promotions.js";

// 模拟「写稿中途技能里的写法改了」：只替换 currentMethod 的返回（不改 SKILL.md）；pinMethod 仍按真实技能存快照
const methodState = vi.hoisted(() => ({ fake: null as null | { version: string; text: string } }));
vi.mock("../modules/exemplar/method.js", async (orig) => {
  const real = await orig<typeof import("../modules/exemplar/method.js")>();
  return { ...real, currentMethod: async (f?: string) => methodState.fake ?? real.currentMethod(f) };
});

let dir: string;
const run = (action: string, args: Record<string, unknown> = {}) => executeDraft({ action, ...args, _dataDir: dir, _host: "claude-code", _session: "verify" });
const BODY = "一块屏，第一天没人看。我给一个听障咖啡师做的。她咖啡做得很好，可她没法一个人接待顾客，因为顾客张嘴就点单，她听不见。我想这事不难，做块屏，顾客在屏上点，她在后台看。结果第一天，没有一个顾客看那块屏。";
const ANGLE = { main_line: "m", for_whom: "职场人", opening: "o", why_viral: "无", chain: ["一", "二", "三", "四"], founder_words: "就这个" };
const put = (id: string, genre: "ganhuo" | "renwu" | "any", kind: "exemplar" | "structure_card" | "technique_card", text = `# ${id}\n全文`) =>
  putExemplar({ id, genre, kind, title: id, text }, dir);

async function started(inspiration = "测试"): Promise<{ id: string; v: number }> {
  const s = await run("start", { inspiration });
  return { id: s.content_id as string, v: (s.progress as { version: number }).version };
}
async function drafted(genre = "ganhuo"): Promise<{ id: string; v: number }> {
  const { id, v } = await started();
  expect((await run("angle", { content_id: id, base_version: v, genre, ...ANGLE, exemplars: [] })).ok).toBe(true);
  await pickOpening(run, id, v);
  const s = await run("save", { content_id: id, base_version: v, body: BODY });
  expect(s.ok).toBe(true);
  return { id, v: s.version as number };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-1015-"));
  await updateProfile({ industry: "AI 实操", platforms: ["douyin"] }, dir);
  setQuoteFetch(async (url) => ({ finalUrl: url, title: "", text: "" }));
  methodState.fake = null;
});
afterEach(async () => { setQuoteFetch(undefined); methodState.fake = null; await fs.rm(dir, { recursive: true, force: true }); });

describe("§10 体裁无范文", () => {
  it("本体裁只有结构卡：写明「本体裁只有结构卡，没有完整范文」（结构卡不算范文）", async () => {
    await put("bench-card", "renwu", "structure_card");
    await put("bench-any", "any", "technique_card");
    const p = await run("exemplars", { genre: "renwu" });
    expect(p.ok).toBe(true);
    expect(p.note).toContain("本体裁只有结构卡，没有完整范文");
  });

  it("真空体裁（只有 any 手法卡）写明本体裁无范文", async () => {
    await put("bench-any", "any", "technique_card");
    const p = await run("exemplars", { genre: "renwu" });
    expect(p.note).toContain("本体裁无范文");
  });
});

describe("§15.10 预算：不截半篇", () => {
  it("第一篇就超预算：整篇跳过、给后面放得下的；每篇 text 与文件逐字一致", async () => {
    await put("bench-a-huge", "ganhuo", "exemplar", `# huge\n${"字".repeat(18_500)}`);
    await put("bench-b", "ganhuo", "exemplar", `# b\n${"中".repeat(9_000)}尾巴。`);
    await put("bench-c", "ganhuo", "exemplar", `# c\n${"文".repeat(8_900)}结尾句。`);
    const p = await run("exemplars", { genre: "ganhuo" }) as { entries: Array<{ id: string; text: string; chars: number }>; skipped: Array<{ id: string }> };
    expect(p.entries.map((e) => e.id)).toEqual(["bench-b", "bench-c"]);
    for (const e of p.entries) {
      expect(e.text).toBe(await fs.readFile(exemplarVersionPath(e.id, 1, dir), "utf8"));
      expect(e.chars).toBe(Array.from(e.text).length);
    }
    expect(p.skipped.map((s) => s.id)).toContain("bench-a-huge");
    expect(p.entries.reduce((s, e) => s + e.chars, 0)).toBeLessThanOrEqual(18_000);
  });
});

describe("§15.5 锁版", () => {
  it("写法在技能里改了：续写仍给锁住那一版的全文，并提示改过", async () => {
    const { id, v } = await started();
    const a = await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: [] });
    const pinned = a.method_version as string;
    const before = (await run("start", { content_id: id }) as { progress: { method: { text: string } } }).progress.method.text;
    methodState.fake = { version: "0123456789abcdef", text: "全新的写法" };
    const r = await run("start", { content_id: id }) as { progress: { method: { version: string; text: string; note?: string } } };
    expect(r.progress.method.version).toBe(pinned);
    expect(r.progress.method.text).toBe(before);
    expect(r.progress.method.note).toContain("改过");
  });

  it("[发现] angle 锁的范文文件已损坏（指纹对不上）时应拒或明确警告，而不是静默锁上", async () => {
    await put("bench-a", "ganhuo", "exemplar", "# a\n原文");
    await fs.appendFile(exemplarVersionPath("bench-a", 1, dir), "被改了");
    const { id, v } = await started();
    const a = await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: [{ id: "bench-a", version: 1 }] });
    const warned = !a.ok || JSON.stringify(a).includes("对不上") || JSON.stringify(a).includes("损坏");
    expect(warned).toBe(true);
  });

  it("续写使用次数：同一篇稿同体裁重出立意多次，只算一次", async () => {
    await put("bench-a", "ganhuo", "exemplar");
    await put("bench-b", "ganhuo", "exemplar");
    const { id, v } = await started();
    await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: [{ id: "bench-a", version: 1 }] });
    await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: [{ id: "bench-a", version: 1 }] });
    await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: [{ id: "bench-a", version: 1 }] });
    const p = await run("exemplars", { genre: "ganhuo" }) as { entries: Array<{ id: string; used_30d: number }> };
    expect(p.entries.find((e) => e.id === "bench-a")?.used_30d).toBe(1);
  });
});

describe("§15.13 开头三选一断点续上", () => {
  it("[发现] 连着两轮都不满意回 back_to_angle 后，断线重连的 progress / next_action 应指向回立意，而不是继续「等你选开头 / 出候选」", async () => {
    const { id, v } = await started();
    await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: [] });
    await run("opening", { content_id: id, base_version: v, candidates: OPENINGS });
    await run("opening", { content_id: id, base_version: v, candidates: OPENINGS.map((x) => `${x}再来`), founder_words: "都不行" });
    expect(await run("opening", { content_id: id, base_version: v, candidates: OPENINGS, founder_words: "还是不行" })).toMatchObject({ code: "back_to_angle" });
    const r = await run("start", { content_id: id }) as { progress: Record<string, unknown>; next_action: { note: string } };
    const said = JSON.stringify(r.progress.opening_pick) + r.next_action.note;
    expect(said).toMatch(/立意/);
    expect(said).not.toContain("等你选开头");
  });

  it("[发现] 已有正文的稿重出立意：回执不该叫去磨开头（opening 会被 has_body 拒）", async () => {
    await put("bench-a", "ganhuo", "exemplar");
    const { id, v } = await drafted("ganhuo");
    const a = await run("angle", { content_id: id, base_version: v, genre: "renwu", ...ANGLE, exemplars: [] });
    expect(a.ok).toBe(true);
    const o = await run("opening", { content_id: id, base_version: v, candidates: OPENINGS });
    expect(o.code).toBe("has_body");
    expect((a.next_action as { note: string }).note).not.toContain("先磨开头");
  });

  it("选开头不进意见记录；带 founder_words 重出才记 stage=opening", async () => {
    const { id, v } = await started();
    await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: [] });
    await pickOpening(run, id, v);
    const h = await run("feedback_history") as { entries: Array<{ content_id: string }> };
    expect(h.entries.filter((e) => e.content_id === id)).toEqual([]);
  });
});

describe("AGENTS.md：模型参数可能是 JSON 字符串、带裸引号", () => {
  it("exemplars：带裸内引号的 JSON 字符串能修就修", async () => {
    await put("bench-a", "ganhuo", "exemplar");
    const { id, v } = await started();
    const a = await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: '[{"id":"bench-a","version":1,"why":"借"闯关"那招"}]' });
    expect(a).toMatchObject({ ok: true, exemplars: [{ id: "bench-a", version: 1 }] });
  });

  it("exemplars：对象 / 普通字符串 / 修不好的 JSON → 可见拒绝，不当空数组", async () => {
    const { id, v } = await started();
    for (const bad of ['{"id":"bench-a","version":1}', "bench-a", '[{"id":"bench-a", "version":1', { id: "bench-a", version: 1 }, 42]) {
      const a = await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: bad });
      expect(a, JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    const s = await run("start", { content_id: id }) as { progress: { angle: unknown } };
    expect(s.progress.angle).toBeNull();
  });

  it("candidates：带裸内引号的 JSON 字符串修好后仍是 3 条，内容不丢", async () => {
    const { id, v } = await started();
    await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: [] });
    const r = await run("opening", { content_id: id, base_version: v, candidates: '["一块"点单屏"没人看", "她听不见", "第一天就出事"]' });
    expect(r.ok).toBe(true);
    const s = await run("start", { content_id: id }) as { progress: { opening_pick: { candidates: string[] } } };
    expect(s.progress.opening_pick.candidates).toEqual(['一块"点单屏"没人看', "她听不见", "第一天就出事"]);
  });

  it("candidates：数组里混了对象 / 只给一行 → 可见拒绝", async () => {
    const { id, v } = await started();
    await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: [] });
    expect(await run("opening", { content_id: id, base_version: v, candidates: [{ text: "a" }, "b", "c"] })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("opening", { content_id: id, base_version: v, candidates: "一\n二\n三" })).toMatchObject({ ok: false, code: "bad_param" });
  });

  it("test_read：裸内引号能修；数组 / 数字 → 拒", async () => {
    const { id, v } = await drafted();
    const ok = await run("save", { content_id: id, base_version: v, body: BODY, test_read: '{"status":"ok","notes":"第 3 秒"一块屏"我会看下去"}' });
    expect(ok.ok).toBe(true);
    for (const bad of ['["ok","x"]', 7, ["ok"]]) expect(await run("save", { content_id: id, base_version: v, body: BODY, test_read: bad }), JSON.stringify(bad)).toMatchObject({ ok: false, code: "bad_param" });
  });

  it("cites：带裸内引号的 JSON 字符串能修；修不了 → 可见拒绝", async () => {
    const a = await drafted();
    const b = await drafted();
    await run("save", { content_id: a.id, base_version: a.v, body: BODY, feedback: { founder_words: "先别说破" } });
    await run("save", { content_id: b.id, base_version: b.v, body: BODY, feedback: { founder_words: "又说破了" } });
    const cites = `[{"content_id":"${a.id}","index":1,"quote":"他说"别说破""},{"content_id":"${b.id}","index":"1"}]`;
    const r = await run("propose_promotion", { content_id: a.id, target: "method", cites, text: "结论别提前说破", note: "两篇都说了" });
    expect(r).toMatchObject({ ok: true, outcome: "proposed" });
    expect(await run("propose_promotion", { content_id: a.id, target: "method", cites: `[{"content_id":"${a.id}",`, text: "x", note: "y" })).toMatchObject({ ok: false, code: "bad_param" });
  });
});

describe("§6 / §15.6–15.8 跨稿学习", () => {
  it("[发现] 否决过一份提案后，完全不同的新提案也被挡（运算符优先级）", async () => {
    const cites = [{ content_id: "c1", index: 1, founder_words: "a" }, { content_id: "c2", index: 1, founder_words: "b" }];
    const first = await proposePromotion({ target: "method", text: "写法 A", reason: "r", cites }, dir);
    const p = (await readPromotions(dir)).find((x) => x.id === first.id)!;
    await decidePromotion(p.id, p.gen, "reject", "不要", dir);
    const second = await proposePromotion({ target: "method", text: "完全不同的写法 B", reason: "r", cites }, dir);
    expect(second.outcome).toBe("proposed");
  });

  it("[发现] 提案被挡（blocked_by_rejected / duplicate）时回执不该说「已进等你拍板」", async () => {
    const a = await drafted();
    const b = await drafted();
    await run("save", { content_id: a.id, base_version: a.v, body: BODY, feedback: { founder_words: "先别说破" } });
    await run("save", { content_id: b.id, base_version: b.v, body: BODY, feedback: { founder_words: "又说破了" } });
    const args = { content_id: a.id, target: "method", cites: [{ content_id: a.id, index: 1 }, { content_id: b.id, index: 1 }], text: "结论别提前说破", note: "n" };
    expect((await run("propose_promotion", args)).outcome).toBe("proposed");
    const dup = await run("propose_promotion", args);
    expect(dup.outcome).toBe("duplicate");
    expect(JSON.stringify(dup.next_action)).not.toContain("已进「等你拍板」");
  });

  it("示例稿的意见不能当升级出处", async () => {
    const a = await drafted();
    const b = await drafted();
    await run("save", { content_id: a.id, base_version: a.v, body: BODY, feedback: { founder_words: "先别说破" } });
    await run("save", { content_id: b.id, base_version: b.v, body: BODY, feedback: { founder_words: "又说破了" } });
    await updateContent(b.id, { example: true } as never, dir);
    const r = await run("propose_promotion", { content_id: a.id, target: "method", cites: [{ content_id: a.id, index: 1 }, { content_id: b.id, index: 1 }], text: "x", note: "y" });
    expect(r).toMatchObject({ ok: false, code: "bad_cites" });
  });


});

describe("§15.12 试读", () => {
  it("unsupported 不算已审；prepare_final 回执写明", async () => {
    const { id, v } = await drafted();
    await run("save", { content_id: id, base_version: v, body: BODY, test_read: { status: "unsupported", notes: "这个宿主没有子代理也没有 codex" } });
    const p = await run("prepare_final", { content_id: id, base_version: v, citations: [] });
    expect(p.ok).toBe(true);
    expect(p.review).toMatchObject({ kind: "viewer_test_read", status: "unsupported", reviewed: false, current: true });
  });


});

describe("§10 近 30 天用过 2 次的往后排", () => {
  it("[发现] 替补只能是本体裁范文：用过多次的本体裁范文不该被 any 手法卡挤掉，变成「本体裁无范文」", async () => {
    await put("bench-g", "ganhuo", "exemplar");
    for (const id of ["bench-t1", "bench-t2", "bench-t3"]) await put(id, "any", "technique_card");
    for (let i = 0; i < 2; i++) {
      const { id, v } = await started();
      await run("angle", { content_id: id, base_version: v, genre: "ganhuo", ...ANGLE, exemplars: [{ id: "bench-g", version: 1 }] });
    }
    const p = await run("exemplars", { genre: "ganhuo" }) as { entries: Array<{ id: string }>; note?: string };
    expect(p.entries.map((e) => e.id)).toContain("bench-g");
  });
});
