/** 卡片候选的人话（1b 预演反馈）：来源、原因、依据；在访达中显示只认这条候选自己的文件 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fact } from "../../storage/production-types.js";
import { candidateRow } from "./candidate-view.js";
import { revealFactPath } from "./sources-view.js";
import { makeEnv, put, record, videoContent, type Env } from "./testkit.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";

const dirs = { inbox: "/lib/inbox", chatcut: "/m/ChatCut", jianying: "/m/jy" };
const base = (over: Partial<Fact>): Fact => ({ id: "f1", kind: "aroll", round: 1, state: "candidate", availability: "present", source: "reconcile", at: "t", sha256: "s", ...over });
const match = (winner: string | null, reason = "开头转写对上") => ({ winner, reason, top3: [{ content_id: "c-a", title: "甲稿", l1: "none", l2: 0.576 }, { content_id: "c-b", title: "乙稿", l1: "none", l2: 0.075 }] });

describe("候选一行的人话", () => {
  it("第一行只有种类、文件名、来源；分数与完整路径只在依据里", () => {
    const r = candidateRow(base({ path: "/u/downloads/IMG_0421.MOV", evidence: "开头转写对上《甲稿》（0.576，领先 0.501）", match: match("c-a") }), "c-a", dirs);
    expect(r).toMatchObject({ name: "原片 · IMG_0421.MOV", origin: "对账发现", reason: "开头说的话和这条稿对上了" });
    expect(`${r.name}${r.origin}${r.reason}`).not.toMatch(/0\.576|\/u\//);
    expect(r.detail).toContain("/u/downloads/IMG_0421.MOV");
    expect(r.detail).toContain("0.576");
  });
  it("来源：收件箱 / ChatCut 导出 / 剪映导出 / agent 报的 / 你挂的；原因：文件名对上 / 更像别条", () => {
    expect(candidateRow(base({ path: "/lib/inbox/a.mov", evidence: "文件名前缀对上标题（原片收件箱）" }), "c-a", dirs)).toMatchObject({ origin: "收件箱", reason: "文件名对上标题" });
    expect(candidateRow(base({ kind: "cut", path: "/m/ChatCut/x.mp4" }), "c-a", dirs).origin).toBe("ChatCut 导出");
    expect(candidateRow(base({ kind: "cut", path: "/m/jy/x.mp4" }), "c-a", dirs).origin).toBe("剪映导出");
    expect(candidateRow(base({ source: "record", path: "/x/y.mov" }), "c-a", dirs).origin).toBe("agent 报的");
    expect(candidateRow(base({ source: "founder", path: "/x/y.mov" }), "c-a", dirs).origin).toBe("你挂的");
    expect(candidateRow(base({ path: "/lib/inbox/a.mov", match: match("c-b") }), "c-a", dirs).reason).toBe("听起来更像《乙稿》");
  });
});

describe("在访达中显示（候选）", () => {
  let env: Env;
  beforeEach(async () => { env = await makeEnv({ enabled: true }); });
  afterEach(async () => { await env.cleanup(); });
  it("只认这条稿本轮候选自己的文件；别的 fact id 拒", async () => {
    const c = await videoContent(env, "访达候选测试稿");
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.outside, "x.mov"), "x"), request_id: "r1" });
    const f = (await readProductionDocOrEmpty(c.id, env.dir)).facts[0];
    expect(await revealFactPath(c.id, f.id, env.dir, { platform: "linux" })).toMatchObject({ ok: true, path: path.join(env.outside, "x.mov") });
    expect(await revealFactPath(c.id, "fact-nope", env.dir, { platform: "linux" })).toMatchObject({ ok: false, code: "not_allowed" });
  });
});
