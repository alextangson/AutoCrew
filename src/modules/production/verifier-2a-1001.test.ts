/**
 * 2026-10-01 verifier：在资料库克隆（:4323）上实跑「等你拍板」2a 与本体 1b 之后补的边界测试。
 * 每条都先在克隆上复现过（报告：~/.cache/autocrew-verify/report-2a.md）。
 * 标 it.skip 的是**发现**：代码现在的行为与 spec 不符，测试按 spec 写、保持原样，等创始人决定谁来修——不要为了变绿改断言。
 * 只用临时库；fixtures 不含真实稿件文本。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { contentSummary } from "../../tools/content-summary.js";
import { executeContentSave } from "../../tools/content-save.js";
import { validCoverGroups } from "./cover-groups.js";
import { founderDecision } from "./decisions.js";
import { decideItem } from "./inbox-decide.js";
import { readInbox } from "./inbox-read.js";
import { plainReason } from "./plain-reason.js";
import { reconcileAll } from "./reconcile.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, videoContent, waiveSliverCheck, type Env } from "./testkit.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const doc = async (id: string) => (await readProductionDoc(id, env.dir))!;
const items = async (contentId?: string) => (await readInbox(env.dir, { ...(contentId ? { contentId } : {}), withDrafts: true })).items;
const itemStarting = async (contentId: string, prefix: string) => (await items(contentId)).find((i) => i.item_id.startsWith(`${prefix}:${contentId}`));

async function editing(title: string) {
  const c = await videoContent(env, title);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${title}-原片.mov`), `raw-${title}`), request_id: "a" });
  return c;
}

async function markedCut(contentId: string, name: string, bytes: string, rid: string) {
  const r = await record(env, { content_id: contentId, kind: "cut", path: await put(path.join(env.chatcut, name), bytes), request_id: rid, review: true }, "claude-code");
  const sha = (await doc(contentId)).facts.find((f) => f.id === r.fact_id)!.sha256!;
  return { fact_id: r.fact_id as string, sha };
}

describe("成片：创始人点了「还要改…」之后（§3.3）", () => {
  // 克隆实跑：qt2ixd 打回后 summary.reason「有成片待你审」、卡片「下一步：成片出来了，等你看」、工作台同句
  it("[P1] 打回后，摘要不再说「成片待你审」 — FINDING: explain 不看 cut_reject，打回后仍报「成片待你审」", async () => {
    const c = await editing("打回后状态稿");
    await markedCut(c.id, "打回后状态稿.mp4", "cut-1", "c1");
    const it0 = (await itemStarting(c.id, "cut"))!;
    const r = await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "reject_cut", note: "开头有点拖，前 10 秒再紧一点", content_id: c.id }, env.dir);
    expect(r.ok).toBe(true);
    const s = await contentSummary(c.id, env.dir);
    expect(s.missing as string[]).not.toContain("成片待你审");
    expect(String(s.reason ?? "")).not.toContain("成片待你审");
  });

  // spec §3.3「还要改… → 写一句话发给 agent」：克隆实跑，summary 只有 changes[].type=cut_rejected，get 里也没有原话
  it("[P1] 打回的那句话 agent 能从 autocrew_content summary 读到 — FINDING: 原话只在 production.json / timeline.jsonl，MCP 读不到", async () => {
    const c = await editing("打回原话稿");
    await markedCut(c.id, "打回原话稿.mp4", "cut-1", "c1");
    const it0 = (await itemStarting(c.id, "cut"))!;
    await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "reject_cut", note: "前十秒再紧一点", content_id: c.id }, env.dir);
    const pages: string[] = [];
    let since = 0;
    for (let i = 0; i < 10; i++) {
      const s = await contentSummary(c.id, env.dir, Date.now(), since);
      pages.push(JSON.stringify(s));
      if (!s.has_more) break;
      since = Number(s.next_since_seq);
    }
    expect(pages.join("\n")).toContain("前十秒再紧一点");
  });

  it("[P2] 打回的那一版，闪帧条目不再挂在列表里 — FINDING: sliverItems 只跳过已批的那版，打回的那版的闪帧行一直留着", async () => {
    const c = await editing("打回闪帧稿");
    const v1 = await markedCut(c.id, "打回闪帧稿.mp4", "cut-1", "c1");
    const it0 = (await itemStarting(c.id, "cut"))!;
    await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "reject_cut", note: "再改", content_id: c.id }, env.dir);
    expect(await itemStarting(c.id, "cut")).toBeUndefined();
    expect((await items(c.id)).filter((i) => i.type === "sliver" && i.detail.cut_fact_id === v1.fact_id)).toEqual([]);
  });
});

describe("成片：挑了上一版之后（§7-2「抽帧检查按所选成片算」）", () => {
  it("[P2] 没被选中的那一版，闪帧条目跟着消失 — FINDING: 选了 v1 后 v2 的「画面闪帧检查没跑成」还在列表里", async () => {
    const c = await editing("挑上一版稿");
    const v1 = await markedCut(c.id, "挑上一版稿-1.mp4", "cut-1", "c1");
    const v2 = await markedCut(c.id, "挑上一版稿-2.mp4", "cut-2", "c2");
    await waiveSliverCheck(env, c.id, v1.sha);
    const it0 = (await itemStarting(c.id, "cut"))!;
    const r = await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "approve_cut", fact_id: v1.fact_id, content_id: c.id }, env.dir);
    expect(r.ok).toBe(true);
    expect((await doc(c.id)).decisions.find((d) => d.type === "cut_approval")).toMatchObject({ sha256: v1.sha });
    expect(await itemStarting(c.id, "cut")).toBeUndefined();
    expect((await items(c.id)).filter((i) => i.type === "sliver" && i.detail.cut_fact_id === v2.fact_id)).toEqual([]);
  });

  it("[P2] 抽帧没放行时不给一个点了必报错的主按钮（§4.2 条件不够写原因） — FINDING: 「就用这版」照给，点了回 sliver_blocked", async () => {
    const c = await editing("抽帧没放行稿");
    await markedCut(c.id, "抽帧没放行稿.mp4", "cut-1", "c1");
    const it0 = (await itemStarting(c.id, "cut"))!;
    const r = await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "approve_cut", content_id: c.id }, env.dir);
    expect(r).toMatchObject({ ok: false, code: "sliver_blocked" });
    // 主按钮注定失败 → 条目应在按钮位置写原因（blocked_reason），而不是给黑底「就用这版」
    expect(it0.blocked_reason).toBeTruthy();
  });
});

describe("封面：对账先收了 05-cover/vNNN，agent 再 record paths 同两张（克隆实跑复现）", () => {
  async function setup(title: string) {
    const c = await editing(title);
    const root = projectRoot(env, c.id);
    const a = await put(path.join(root, "05-cover", "v001", "cover-3x4.png"), png(900, 1200, "a"));
    const b = await put(path.join(root, "05-cover", "v001", "cover-4x3.png"), png(1200, 900, "b"));
    await reconcileAll(env.dir);
    const r = await record(env, { content_id: c.id, kind: "cover", paths: [a, b], cover_text: "三个瞬间", request_id: "g1" }, "claude-code");
    expect(r).toMatchObject({ ok: true });
    return c;
  }

  it("[P2] 同样两张不变成两组（面板上同一对图出现两次） — FINDING: record paths 新建了第二个组，成员与对账组完全相同", async () => {
    const c = await setup("封面重复组稿");
    const complete = validCoverGroups(await doc(c.id)).filter((g) => g.complete);
    const pairs = complete.map((g) => `${g.slots["3:4"][0].sha256}|${g.slots["4:3"][0].sha256}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("[P2] record 带的封面字成为默认值 — FINDING: 事实先被对账收了，record 不回写 text，面板上封面字是空的", async () => {
    const c = await setup("封面字丢失稿");
    const it0 = (await itemStarting(c.id, "cover"))!;
    const groups = it0.detail.groups as Array<{ text: string }>;
    expect(groups[0].text).toBe("三个瞬间");
  });
});

describe("原片候选：同一段字节已经挂到了别处（1b §3-7 独占）", () => {
  it("[P2] 别条稿上同一文件的候选不再给一个点了必失败的「对，就是它」 — FINDING: 条目留着，确认回 path_missing（还带绝对路径）", async () => {
    const a = await videoContent(env, "独占甲稿");
    await founderApprove(env, a.id);
    const b = await videoContent(env, "独占乙稿");
    await founderApprove(env, b.id);
    const src = await put(path.join(env.inbox, "IMG_0001.mov"), "take");
    const r = await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "a1" });
    expect(r).toMatchObject({ state: "candidate" });
    expect(await founderDecision(b.id, "attach_aroll", { path: src }, env.dir)).toMatchObject({ ok: true, state: "accepted" });
    const stale = (await items(a.id)).find((i) => i.type === "candidate" && i.detail.kind === "aroll");
    if (stale) {
      const res = await decideItem({ item_id: stale.item_id, gen: stale.gen, action: "confirm_candidate", content_id: a.id }, env.dir);
      // 要么条目已经不在，要么点下去能成；不能是一个永远点不成、也不写原因的行
      expect(res.ok === true || Boolean(stale.blocked_reason)).toBe(true);
    }
  });
});

describe("候选的「为什么」（plain-reason）", () => {
  it("[P3] 依据里别条稿的标题碰巧含「转写」，不能把文件名命中说成「开头说的话对上了」 — FINDING: 正则扫整段依据，连前三名的标题一起扫", () => {
    const r = plainReason({ id: "f", kind: "aroll", state: "candidate", round: 1, at: "2026-10-01T00:00:00.000Z", source: "reconcile",
      evidence: "监视文件夹 w：文件名对上《乙稿》，池里没有别条对得上；前三名：《乙稿》（文件名对上）、《转写比对甲》" } as Parameters<typeof plainReason>[0]);
    expect(r).toBe("文件名和标题对上了");
  });
});

describe("回归护栏（克隆实跑通过的行为，补成测试）", () => {
  it("两条稿同一轮的成片条目各占一行，批一条不动另一条的代次", async () => {
    const a = await editing("同轮甲稿");
    const b = await editing("同轮乙稿");
    const va = await markedCut(a.id, "同轮甲稿.mp4", "cut-a", "ca");
    await markedCut(b.id, "同轮乙稿.mp4", "cut-b", "cb");
    const ia = (await itemStarting(a.id, "cut"))!;
    const ib = (await itemStarting(b.id, "cut"))!;
    expect(ia.item_id).not.toBe(ib.item_id);
    await waiveSliverCheck(env, a.id, va.sha);
    const ia2 = (await itemStarting(a.id, "cut"))!;
    expect(await decideItem({ item_id: ia2.item_id, gen: ia2.gen, action: "approve_cut", content_id: a.id }, env.dir)).toMatchObject({ ok: true });
    expect((await itemStarting(b.id, "cut"))!.gen).toBe(ib.gen);
  });

  it("稿子刚改过：旧代次认稿回「稿子刚改过，重新看一眼」，不写", async () => {
    const c = await videoContent(env, "改稿代次稿");
    const it0 = (await itemStarting(c.id, "draft"))!;
    await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: "claude-code", action: "update", id: c.id, body: "改过的正文。" });
    const r = await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "approve_script", content_id: c.id }, env.dir);
    expect(r).toMatchObject({ ok: false, code: "stale", error: "稿子刚改过，重新看一眼" });
    expect((await videoContent(env, "无关稿")).status).toBe("draft_ready");
  });

  it("花费请示：answer_ask 收对话原话，记成对话来源（R7 改：对话原话 = 决定）", async () => {
    const c = await editing("转述边界稿");
    const ask = await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: "codex", action: "ask", content_id: c.id, request_id: "cost", kind: "花费", question: "要花 12 元，做吗？",
      options: [{ id: "yes", label: "做" }, { id: "no", label: "不做" }] }) as Record<string, unknown>;
    const r = await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: "codex", action: "answer_ask", content_id: c.id, ask_id: ask.ask_id, option_id: "yes", founder_quote: "做吧" }) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, via: "chat", decision: { source: "chat", founder_words: "做吧" } });
  });
});
