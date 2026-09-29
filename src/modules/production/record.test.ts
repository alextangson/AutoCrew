import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardData } from "../../desktop/board-data.js";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDoc, writeEnabledVersion } from "../../storage/production-store.js";
import { getContent } from "../../storage/local-store.js";
import { recoverArollMoves } from "../video/handoff/aroll-move.js";
import { exists, founderApprove, makeEnv, png, projectRoot, put, record, SRT, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const TITLE = "AI 又忘了怎么办";

describe("record：可搬入根 vs 其他路径（§3-5）", () => {
  it("收件箱里文件名对上标题的原片：挪进 02-aroll 改名「<标题>-原片」，accepted，源路径空了", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "aroll-bytes");
    const r = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" });
    expect(r).toMatchObject({ ok: true, kind: "aroll", state: "accepted", path: "02-aroll/AI 又忘了怎么办-原片.mov" });
    expect(await exists(src)).toBe(false);
    expect(await fs.readFile(path.join(projectRoot(env, c.id), "02-aroll/AI 又忘了怎么办-原片.mov"), "utf8")).toBe("aroll-bytes");
    expect(String(r.next_action)).toContain("chatcut_project");
  });

  it("第二条原片接 -2", async () => {
    const c = await videoContent(env, TITLE);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-a.mov"), "take-1"), request_id: "r1" });
    const r = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-b.mov"), "take-2"), request_id: "r2" });
    expect(r).toMatchObject({ ok: true, path: "02-aroll/AI 又忘了怎么办-原片-2.mov" });
  });

  it("其他路径（不可搬入）只记候选，不挪、不克隆", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.outside, "随便.mov"), "maybe");
    const r = await record(env, { content_id: c.id, kind: "cut", path: src, request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "candidate", path: src });
    expect(await exists(src)).toBe(true);
    expect(await exists(path.join(projectRoot(env, c.id), "04-edit"))).toBe(false);
  });

  it("导出目录里的 A-roll 不可搬入（导出目录只收 cut/srt/cover）→ 候选", async () => {
    const c = await videoContent(env, TITLE);
    const r = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.chatcut, "AI又忘了怎么办-原片.mov"), "x"), request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "candidate" });
  });

  it("项目内的文件原地 accepted", async () => {
    const c = await videoContent(env, TITLE);
    await put(path.join(projectRoot(env, c.id), "04-edit/final.mp4"), "cut");
    const r = await record(env, { content_id: c.id, kind: "cut", path: path.join(projectRoot(env, c.id), "04-edit/final.mp4"), request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "accepted", path: "04-edit/final.mp4" });
  });

  it("文件名对不上标题的收件箱原片：记成候选等创始人确认（看板数据里可见），原件不动", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, "IMG_0001.mov"), "x");
    expect(await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" })).toMatchObject({ ok: true, state: "candidate", path: src });
    expect(await exists(src)).toBe(true);
    const item = (await boardData(env.dir)).items.find((i) => i.id === c.id)!;
    expect(item.candidates).toMatchObject([{ kind: "aroll", path: src }]);
  });

  it("[Codex P1 record.ts:35] 影子模式（未启用）：record 拒，不写事实、不搬文件", async () => {
    const shadow = await makeEnv();
    try {
      const c = await videoContent(shadow, TITLE);
      const src = await put(path.join(shadow.inbox, "AI又忘了怎么办-原片.mov"), "raw");
      expect(await record(shadow, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" })).toMatchObject({ ok: false, code: "ontology_not_enabled" });
      expect(await exists(src)).toBe(true);
      expect(await readProductionDoc(c.id, shadow.dir)).toBeNull();
    } finally { await shadow.cleanup(); }
  });

  it("[Codex P1 record.ts:65] 项目的 02-aroll 是指向库外的符号链接：拒，原片不动", async () => {
    const c = await videoContent(env, TITLE);
    const elsewhere = path.join(env.outside, "escape");
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.symlink(elsewhere, path.join(projectRoot(env, c.id), "02-aroll"));
    const src = await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw");
    expect(await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" })).toMatchObject({ ok: false, code: "target_unsafe" });
    expect(await exists(src)).toBe(true);
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });
});

describe("record：克隆（§3-7，§13-B）", () => {
  it("导出目录的成片 APFS 克隆进 04-edit；之后外部原地覆盖不影响项目内那份", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.chatcut, "AI又忘了怎么办.mp4"), "cut-v1");
    const r = await record(env, { content_id: c.id, kind: "cut", path: src, request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "accepted", path: "04-edit/AI又忘了怎么办.mp4" });
    expect(await exists(src)).toBe(true);
    await fs.writeFile(src, "cut-v2-overwritten");
    const inside = path.join(projectRoot(env, c.id), "04-edit/AI又忘了怎么办.mp4");
    expect(await fs.readFile(inside, "utf8")).toBe("cut-v1");
    expect((await fs.stat(inside)).ino).not.toBe((await fs.stat(src)).ino);
  });

  it("封面按像素核比例、放进 05-cover/vNNN，cover_text 只是默认值", async () => {
    const c = await videoContent(env, TITLE);
    const r = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c.png"), png(900, 1200)), ratio: "3x4", cover_text: "AI 又忘了？", request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "accepted", path: "05-cover/v001/封面-3x4.png" });
    const bad = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "d.png"), png(1200, 900, "y")), ratio: "3:4", request_id: "r2" });
    expect(bad).toMatchObject({ ok: false, code: "cover_invalid" });
    expect((await readProductionDoc(c.id, env.dir))!.decisions).toEqual([]);
  });

  it("字幕 for_cut 可以填成片 fact_id；没成片先报字幕 → 拒", async () => {
    const c = await videoContent(env, TITLE);
    expect(await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "a.srt"), SRT), request_id: "r0" })).toMatchObject({ ok: false, code: "cut_required" });
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "AI又忘了怎么办.mp4"), "cut"), request_id: "r1" });
    const srt = await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "a.srt"), SRT), for_cut: cut.fact_id, request_id: "r2" });
    expect(srt).toMatchObject({ ok: true, state: "accepted" });
    const doc = (await readProductionDoc(c.id, env.dir))!;
    expect(doc.facts.find((f) => f.kind === "srt")!.for_cut).toBe(doc.facts.find((f) => f.kind === "cut")!.sha256);
  });
});

describe("record：检查先于副作用（§3，E5/E7/E21/E24）", () => {
  it.each([
    ["符号链接", async () => { const real = await put(path.join(env.inbox, "real.mov"), "x"); const link = path.join(env.inbox, "AI又忘了怎么办-link.mov"); await fs.symlink(real, link); return link; }, "path_symlink"],
    ["不存在", async () => path.join(env.inbox, "none.mov"), "path_missing"],
    ["10 秒内还在变", async () => put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "x", true), "file_unstable"],
    ["读不出时长", async () => put(path.join(env.inbox, "AI又忘了怎么办-broken.mov"), "x"), "file_unstable"],
  ])("%s → 拒，什么都没写", async (_n, make, code) => {
    const c = await videoContent(env, TITLE);
    const src = await make();
    expect(await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" })).toMatchObject({ ok: false, code });
    expect(await readProductionDoc(c.id, env.dir)).toBeNull();
    expect(await exists(path.join(projectRoot(env, c.id), "02-aroll"))).toBe(false);
  });

  it("iCloud 占位（有大小、零块）→ 拒", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "x");
    const realLstat = fs.lstat;
    const spy = (await import("vitest")).vi.spyOn(fs, "lstat").mockImplementation(async (p, o) => {
      const st = await realLstat(p as string, o as never);
      return p === src ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { blocks: 0, size: 5, isFile: () => true, isSymbolicLink: () => false }) : st;
    });
    try { expect(await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" })).toMatchObject({ ok: false, code: "file_not_local" }); }
    finally { spy.mockRestore(); }
    expect(await exists(src)).toBe(true);
  });

  it("参数正规化：uses_aroll 当字符串、引号坏了也认；version 当字符串也认（E11）", async () => {
    const c = await videoContent(env, TITLE);
    const a = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "x"), request_id: "r1" });
    const r = await record(env, { content_id: c.id, kind: "chatcut_project", chatcut_project_id: "p1", uses_aroll: `['${a.fact_id}']`, request_id: "r2" });
    expect(r).toMatchObject({ ok: true, kind: "chatcut_project" });
    const cov = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c.png"), png(900, 1200)), version: "v7", request_id: "r3" });
    expect(cov).toMatchObject({ ok: true, path: "05-cover/v007/封面-3x4.png" });
    expect(await record(env, { content_id: c.id, kind: "chatcut_project", chatcut_project_id: "p1", uses_aroll: "{{{", request_id: "r4" })).toMatchObject({ ok: false, code: "bad_param" });
  });

  it("kind=publish 这一段明确拒，指路", async () => {
    const c = await videoContent(env, TITLE);
    expect(await record(env, { content_id: c.id, kind: "publish", request_id: "r1" })).toMatchObject({ ok: false, code: "publish_not_supported" });
  });
});

describe("record：幂等、重放、独占（E6/E8/§3-1/§3-4）", () => {
  it("request_id 重放：搬走之后重试不因源路径没了而报错，返回同一条事实", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "x");
    const first = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "same" });
    const again = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "same" });
    expect(again).toMatchObject({ ok: true, replayed: true, fact_id: first.fact_id });
    expect((await readProductionDoc(c.id, env.dir))!.facts).toHaveLength(1);
  });

  it("同条同 (sha, kind) 幂等：换 request_id 再报同一文件，不新增事实", async () => {
    const c = await videoContent(env, TITLE);
    const file = await put(path.join(projectRoot(env, c.id), "04-edit/final.mp4"), "cut");
    const a = await record(env, { content_id: c.id, kind: "cut", path: file, request_id: "r1" });
    const b = await record(env, { content_id: c.id, kind: "cut", path: file, request_id: "r2" });
    expect(b).toMatchObject({ ok: true, fact_id: a.fact_id });
    expect((await readProductionDoc(c.id, env.dir))!.facts).toHaveLength(1);
  });

  it("A-roll 跨条独占：同一原片已是别条的 accepted A-roll → 拒并说出是哪条", async () => {
    const a = await videoContent(env, TITLE);
    const b = await videoContent(env, "完全不同的第二条标题");
    await record(env, { content_id: a.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "same-bytes"), request_id: "r1" });
    const r = await record(env, { content_id: b.id, kind: "aroll", path: await put(path.join(env.inbox, "完全不同的第二条标题.mov"), "same-bytes"), request_id: "r2" });
    expect(r).toMatchObject({ ok: false, code: "aroll_conflict" });
    expect(String(r.error)).toContain(a.id);
  });

  it("同进程两个并发 record 抢同一原片（两份相同字节）：只成功一个", async () => {
    const a = await videoContent(env, TITLE);
    const b = await videoContent(env, "完全不同的第二条标题");
    const [ra, rb] = await Promise.all([
      record(env, { content_id: a.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "r1" }),
      record(env, { content_id: b.id, kind: "aroll", path: await put(path.join(env.inbox, "完全不同的第二条标题.mov"), "raw"), request_id: "r2" }),
    ]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    expect([ra, rb].find((r) => !r.ok)).toMatchObject({ code: "aroll_conflict" });
  });

  it("被 ChatCut 工程引用的原片不挪：候选被再次报成可收时原地 accepted（§13-A，E26）", async () => {
    const c = await videoContent(env, TITLE);
    const outside = await put(path.join(env.outside, "AI又忘了怎么办-原片.mov"), "raw");
    const cand = await record(env, { content_id: c.id, kind: "aroll", path: outside, request_id: "r1" });
    expect(cand).toMatchObject({ state: "candidate" });
    await record(env, { content_id: c.id, kind: "chatcut_project", chatcut_project_id: "p1", uses_aroll: [cand.fact_id], request_id: "r2" });
    await fs.rename(outside, path.join(env.inbox, "AI又忘了怎么办-原片.mov"));
    const r = await record(env, { content_id: c.id, kind: "aroll", path: path.join(env.inbox, "AI又忘了怎么办-原片.mov"), request_id: "r3" });
    expect(r).toMatchObject({ ok: true, state: "accepted", fact_id: cand.fact_id, path: path.join(env.inbox, "AI又忘了怎么办-原片.mov") });
    expect(await exists(path.join(env.inbox, "AI又忘了怎么办-原片.mov"))).toBe(true);
  });

  it("[Codex P1 record-plan.ts:113] ChatCut 引用不是归属授权：库外候选被工程引用后再报，仍只是候选", async () => {
    const c = await videoContent(env, TITLE);
    const outside = await put(path.join(env.outside, "AI又忘了怎么办-原片.mov"), "raw");
    const cand = await record(env, { content_id: c.id, kind: "aroll", path: outside, request_id: "r1" });
    await record(env, { content_id: c.id, kind: "chatcut_project", chatcut_project_id: "p1", uses_aroll: [cand.fact_id], request_id: "r2" });
    expect(await record(env, { content_id: c.id, kind: "aroll", path: outside, request_id: "r3" })).toMatchObject({ ok: true, state: "candidate", fact_id: cand.fact_id });
    expect((await readProductionDoc(c.id, env.dir))!.facts.find((f) => f.id === cand.fact_id)!.state).toBe("candidate");
  });

  it("[Codex P1 record.ts:115] 写事实失败：确定未提交就把搬走的原片撤回，回执照实说", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw");
    const store = await import("../../storage/production-store.js");
    const spy = vi.spyOn(store, "writeProductionDoc").mockRejectedValueOnce(new Error("磁盘满了"));
    try {
      expect(await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" })).toMatchObject({ ok: false, code: "record_failed" });
    } finally { spy.mockRestore(); }
    expect(await fs.readFile(src, "utf8")).toBe("raw");
    expect(await fs.readdir(path.join(projectRoot(env, c.id), "02-aroll"))).toEqual([]);
  });

  it("[Codex P2 production-store.ts:64] request_id 重放不因后面记了 200+ 条请求而失效", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw");
    const first = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "first" });
    for (let i = 0; i < 205; i++) await record(env, { content_id: c.id, kind: "chatcut_project", chatcut_project_id: "p1", request_id: `cc-${i}` });
    expect(await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "first" })).toMatchObject({ ok: true, replayed: true, fact_id: first.fact_id });
  }, 60_000);

  it("[Codex P2 observe.ts:174] 已有字幕没绑成片、再报时带了 for_cut：补上绑定", async () => {
    const c = await videoContent(env, TITLE);
    const root = projectRoot(env, c.id);
    const srt = await put(path.join(root, "04-edit/a.srt"), SRT);
    await put(path.join(root, "04-edit/cut.mp4"), "cut");
    const doc = await import("../../storage/production-store.js");
    // 先人为造一条没绑成片的字幕事实（模拟字幕先于成片被对账）
    await record(env, { content_id: c.id, kind: "cut", path: path.join(root, "04-edit/cut.mp4"), request_id: "c1" });
    const d = (await doc.readProductionDoc(c.id, env.dir))!;
    const cutSha = d.facts[0].sha256!;
    d.facts.push({ id: "fact-srt-x", kind: "srt", round: 1, state: "accepted", availability: "present", source: "reconcile", at: "x", path: "04-edit/a.srt", sha256: (await import("../video/handoff/manifest.js").then((m) => m.sha256File(srt))) });
    await doc.writeProductionDoc(c.id, env.dir, d, d.revision);
    await record(env, { content_id: c.id, kind: "srt", path: srt, for_cut: cutSha, request_id: "s1" });
    expect((await doc.readProductionDoc(c.id, env.dir))!.facts.find((f) => f.id === "fact-srt-x")!.for_cut).toBe(cutSha);
  });

  it("旧恢复器（recoverArollMoves）看不到本体的搬运，不会把没有交接的 record 撤回", async () => {
    const c = await videoContent(env, TITLE);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "x"), request_id: "r1" });
    expect(await recoverArollMoves(env.dir, env.outside)).toEqual([]);
    expect(await exists(path.join(projectRoot(env, c.id), "02-aroll/AI 又忘了怎么办-原片.mov"))).toBe(true);
  });
});

describe("record 与阶段：只报事实，不带批准", () => {
  it("启用后：认过稿的稿报了原片 → 剪辑中，正文冻结；回执里写还差什么", async () => {
    await writeEnabledVersion(env.dir);
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    const r = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "x"), request_id: "r1" });
    expect(r).toMatchObject({ ok: true, stage: "剪辑中", missing: ["成片", "封面(3:4)", "封面(4:3)"] });
    expect((await getContent(c.id, env.dir))!.status).toBe("editing");
    expect((await readProductionDoc(c.id, env.dir))!.frozen).toMatchObject({ round: 1 });
  });

  it("写稿段报原片：仍在写稿中，badge 等你认稿，状态不动", async () => {
    await writeEnabledVersion(env.dir);
    const c = await videoContent(env, TITLE);
    const r = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "x"), request_id: "r1" });
    expect(r).toMatchObject({ ok: true, stage: "写稿中", badges: ["已有 A-roll，等你认稿"] });
    expect((await getContent(c.id, env.dir))!.status).toBe("draft_ready");
  });
});
