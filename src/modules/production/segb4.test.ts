/** Codex 审 segB4 + 隐式 ChatCut 引用守卫：终态失败落到事实、导出目录与监视文件夹重叠、rejected 重放、ChatCut 在用的原片不挪 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact } from "../../storage/production-types.js";
import { founderDecision } from "./decisions.js";
import { reconcileAll } from "./reconcile.js";
import { setChatcutDeps } from "./sliver/chatcut-read.js";
import { exists, founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
let cc: string;
beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  cc = path.join(path.dirname(env.dir), "chatcut-projects");
  setChatcutDeps({ projectsRoot: () => cc });
});
afterEach(async () => { setChatcutDeps(null); await env.cleanup(); });

const A = "撤销守卫测试的正文。".repeat(40);
async function aroll(id: string): Promise<Fact | undefined> {
  const d = await readProductionDocOrEmpty(id, env.dir);
  return d.facts.find((f) => f.kind === "aroll" && f.round === d.round);
}
async function ccProject(name: string, files: string[]): Promise<void> {
  const dir = path.join(cc, `p-${name.length}`, "project.chatcutproject");
  await fs.mkdir(path.join(dir, "assets", "video"), { recursive: true });
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify({ name, projectId: "p1", schemaVersion: 4 }));
  for (const [i, f] of files.entries()) await fs.writeFile(path.join(dir, "assets", "video", `a${i}.json`), JSON.stringify({ id: `a${i}`, type: "video", path: f }));
}

describe("守卫：本机 ChatCut 工程按绝对路径在用的原片不挪（§13-A）", () => {
  const TITLE = "ChatCut在用的原片稿";
  it("record：收件箱里名字对上，但 ChatCut 工程在用 → accepted 留在原处，依据写出工程名", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, `${TITLE}-原片.mov`), "in-use");
    await ccProject("旧剪辑工程", [src]);
    const r = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "accepted", path: src });
    expect(await exists(src)).toBe(true);
    expect((await aroll(c.id))?.evidence).toContain("ChatCut 工程《旧剪辑工程》在用这个文件，留在原处不挪");
  });

  it("卡片挂载 / 确认候选：同样留原处", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    const src = await put(path.join(env.outside, "downloads-take.mov"), "dl");
    await ccProject("下载里那条", [src]);
    expect(await founderDecision(c.id, "attach_aroll", { path: src }, env.dir)).toMatchObject({ ok: true, state: "accepted" });
    expect(await exists(src)).toBe(true);
  });

  it("ChatCut 工程目录读不了 → 核不了就先不挪：记候选、写原因，文件留原处（Codex 审 segB18 P2 取代 segB4 的「照常挪」）", async () => {
    await fs.mkdir(cc, { recursive: true });
    await fs.chmod(cc, 0o000);
    try {
      const c = await videoContent(env, TITLE);
      const src = await put(path.join(env.inbox, `${TITLE}-原片.mov`), "move-me");
      const r = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" });
      expect(r).toMatchObject({ ok: true, state: "candidate" });
      expect(await exists(src)).toBe(true);
      expect((await aroll(c.id))?.evidence).toContain("没读到 ChatCut 工程信息");
    } finally { await fs.chmod(cc, 0o755); }
  });

  it("某个工程的素材 JSON 写了一半（读不出）→ 不当成「没引用」：record 不挪，记候选写原因；巡检也不碰收件箱", async () => {
    const c = await videoContent(env, TITLE);
    const bad = path.join(cc, "p-x", "project.chatcutproject", "assets", "video");
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, "a0.json"), "{\"path\": \"/half");
    const src = await put(path.join(env.inbox, `${TITLE}-原片.mov`), "auto");
    const r = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "candidate" });
    expect((await aroll(c.id))?.evidence).toContain("没读到 ChatCut 工程信息");
    await reconcileAll(env.dir);
    expect(await exists(src)).toBe(true);
    expect((await aroll(c.id))?.state).toBe("candidate");
  });

  it("核不了 ChatCut 时，撤销也不挪：拒并说原因", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${TITLE}-原片.mov`), "undo-me"), request_id: "r1" });
    const f = (await aroll(c.id))!;
    const bad = path.join(cc, "p-y", "project.chatcutproject", "assets", "video");
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, "a0.json"), "not json");
    const r = await founderDecision(c.id, "undo_auto_attach", { fact_id: f.id, sha256: f.sha256 }, env.dir);
    expect(r).toMatchObject({ ok: false });
    expect(String(r.error)).toContain("没读到 ChatCut 工程信息");
    expect((await aroll(c.id))?.state).toBe("accepted");
  });

  it("没装 ChatCut（目录不存在）是正常情况：照常挪，不提示", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, `${TITLE}-原片.mov`), "x");
    expect(await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" })).toMatchObject({ state: "accepted", path: `02-aroll/${TITLE}-原片.mov` });
    expect((await aroll(c.id))?.evidence).not.toContain("ChatCut");
    expect(await exists(path.join(projectRoot(env, c.id), `02-aroll/${TITLE}-原片.mov`))).toBe(true);
  });
});

/** 停用前自动挂上的旧数据：按 record 收下，再补上旧版自动挂上留下的标记（手动收件 spec 2026-10-06 规则 5） */
async function legacyAutoAttached(id: string): Promise<Fact> {
  const { withFileOwnership } = await import("./mutex.js");
  const { mutateProduction } = await import("./service.js");
  await withFileOwnership(() => mutateProduction(id, env.dir, (doc) => {
    const f = doc.facts.find((x) => x.kind === "aroll" && x.round === doc.round && x.state === "accepted")!;
    Object.assign(f, { auto_attached: true, source: "reconcile" });
    return { value: null, events: [] };
  }));
  return (await aroll(id))!;
}

describe("Codex 审 segB5：撤销也守 ChatCut 引用；原地收下的事实路径是绝对的（停用前自动挂上的旧数据照常能撤）", () => {
  const TITLE = "撤销守卫测试的一条稿";
  async function autoMoved(): Promise<{ id: string; fact: Fact; inProject: string }> {
    const c = await videoContent(env, TITLE, "draft_ready", A);
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${TITLE}-原片.mov`), "auto"), request_id: "r1" });
    const fact = await legacyAutoAttached(c.id);
    expect(fact).toMatchObject({ state: "accepted", auto_attached: true, path: `02-aroll/${TITLE}-原片.mov` });
    return { id: c.id, fact, inProject: path.join(projectRoot(env, c.id), fact.path!) };
  }

  it("[P1] 自动挂上后被 ChatCut 工程按路径引用（还没有 uses_aroll 事实）→ 撤销被拒，文件不动", async () => {
    const { id, fact, inProject } = await autoMoved();
    await ccProject("后来导入的工程", [inProject]);
    const r = await founderDecision(id, "undo_auto_attach", { fact_id: fact.id, sha256: fact.sha256 }, env.dir);
    expect(r).toMatchObject({ ok: false, error: "ChatCut 工程《后来导入的工程》在用这个原片，先在 ChatCut 里换掉再点" });
    expect(await exists(inProject)).toBe(true);
    expect((await aroll(id))?.state).toBe("accepted");
  });

  it("[P2] 原地收下的自动挂上（绝对路径）：工程不再引用后撤销 → 不挪任何文件，只记决定、拒事实、解冻", async () => {
    const c = await videoContent(env, TITLE, "draft_ready", A);
    await founderApprove(env, c.id);
    const src = await put(path.join(env.inbox, `${TITLE}-原片.mov`), "in-place");
    await ccProject("临时工程", [src]);
    await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" });
    const fact = await legacyAutoAttached(c.id);
    expect(fact).toMatchObject({ state: "accepted", auto_attached: true, path: src });
    await fs.rm(cc, { recursive: true, force: true });
    const r = await founderDecision(c.id, "undo_auto_attach", { fact_id: fact.id, sha256: fact.sha256 }, env.dir);
    expect(r).toMatchObject({ ok: true, stage: "待录制" });
    expect(await fs.readFile(src, "utf8")).toBe("in-place");
    const doc = await readProductionDocOrEmpty(c.id, env.dir);
    expect(doc.facts.find((f) => f.id === fact.id)).toMatchObject({ state: "rejected", path: src });
    expect(doc.frozen).toBeNull();
    expect(doc.decisions.some((d) => d.type === "auto_attach_undo")).toBe(true);
  });

});

describe("审计补漏：重开文稿也不挪 ChatCut 按路径在用的原片", () => {
  it("本轮原片被 ChatCut 工程按路径引用 → 重开时留在 02-aroll，不进 _作废", async () => {
    const { reopenScript } = await import("./reopen.js");
    const TITLE = "重开守卫测试的一条稿";
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${TITLE}-原片.mov`), "r"), request_id: "r1" });
    const inProject = path.join(projectRoot(env, c.id), `02-aroll/${TITLE}-原片.mov`);
    expect(await exists(inProject)).toBe(true);
    await ccProject("重开前导入的工程", [inProject]);
    expect(await reopenScript(c.id, env.dir)).toMatchObject({ ok: true, round: 2 });
    expect(await exists(inProject)).toBe(true);
  });
});

describe("收下原片 / 成片时也查完整性（Codex 审 segB12 P2）", () => {
  it("名字对上的坏文件做了候选：点「是这条」被拒、原因看得见，文件留原处，事实仍是候选", async () => {
    const TITLE = "坏文件候选测试的稿";
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    const src = await put(path.join(env.outside, `${TITLE}-broken.mp4`), "corrupt");
    await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r0" }).catch(() => undefined);
    const { withFileOwnership } = await import("./mutex.js");
    const { mutateProduction } = await import("./service.js");
    const { cachedSha } = await import("./observe.js");
    const h = await cachedSha(src);
    await withFileOwnership(() => mutateProduction(c.id, env.dir, (doc) => {
      if (!doc.facts.some((f) => f.sha256 === h.sha256)) doc.facts.push({ id: "fact-bad-1", kind: "aroll", round: doc.round, state: "candidate", availability: "present", source: "reconcile", at: new Date().toISOString(), path: src, sha256: h.sha256, size: h.size, mtime_ms: h.mtime_ms, evidence: "监视文件夹：文件名对上" });
      return { value: null, events: [] };
    }));
    const f = (await aroll(c.id))!;
    const r = await founderDecision(c.id, "confirm_candidate", { fact_id: f.id, sha256: f.sha256 }, env.dir);
    expect(r).toMatchObject({ ok: false, code: "file_unstable" });
    expect(String(r.error)).toContain("读不出这个视频的时长");
    expect(await exists(src)).toBe(true);
    expect((await aroll(c.id))?.state).toBe("candidate");
  });
});
