/** 体裁手册的存储与改动（spec 2026-10-13 §1、§3、§8、§9.2/9.6/9.7） */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as roots from "../../storage/storage-roots.js";
import { appendSupplement, decideProposal, proposeLesson, proposeRevision, rollbackPlaybook } from "./changes.js";
import { paragraphDiff } from "./diff.js";
import { loadManifest, loadSeeds, playbooksDir, readVersionText, versionPath, whenToChoose, writeVersionOnce } from "./store.js";
import { PLAYBOOK_IDS, type PlaybookId } from "./types.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "playbook-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

const manifestFile = () => path.join(playbooksDir(dir), "manifest.json");
const err = (p: Promise<unknown>) => p.then(() => { throw new Error("应当失败"); }, (e: { code?: string }) => e);
const approve = (id: PlaybookId, proposal_id: string, gen: string, eventId: string) => decideProposal({ id, proposal_id, gen, decision: "approve", eventId, source: "tool" }, dir);
async function pending(id: PlaybookId) {
  return (await loadManifest(dir)).playbooks.find((p) => p.id === id)!.proposals;
}

describe("种子与读取", () => {
  it("首次读取种进 5 本 v1（agent / seed），正文与仓库默认一致，frontmatter 不进正文", async () => {
    const m = await loadManifest(dir);
    expect(m.playbooks.map((p) => p.id)).toEqual([...PLAYBOOK_IDS]);
    expect(m.playbooks.every((p) => p.current === 1 && p.versions[0].kind === "seed" && p.versions[0].author === "agent")).toBe(true);
    const seeds = await loadSeeds();
    for (const s of seeds) expect(await readVersionText(s.id, 1, dir)).toBe(s.text);
    expect(seeds.find((s) => s.id === "xinxicha")!.name).toBe("信息差/产品");
    expect(seeds.every((s) => !s.text.includes("0.1-draft") && s.text.startsWith("# "))).toBe(true);
    expect(whenToChoose(seeds[0].text)).toContain("观众天天在碰");
  });

  it("manifest 解析失败：报可见错误，不覆盖文件", async () => {
    await loadManifest(dir);
    await fs.writeFile(manifestFile(), "{坏了");
    expect(await err(loadManifest(dir))).toMatchObject({ code: "manifest_corrupt" });
    expect(await fs.readFile(manifestFile(), "utf8")).toBe("{坏了");
  });

  it("种到一半中断：已在且字节相同的版本文件保留，补完 manifest", async () => {
    const seeds = await loadSeeds();
    await writeVersionOnce(seeds[0].id, 1, seeds[0].text, dir);
    const m = await loadManifest(dir);
    expect(m.playbooks).toHaveLength(5);
  });

  it("种到一半中断但版本文件被改过：报错，不覆盖", async () => {
    await fs.mkdir(path.dirname(versionPath("ganhuo", 1, dir)), { recursive: true });
    await fs.writeFile(versionPath("ganhuo", 1, dir), "别人改过");
    expect(await err(loadManifest(dir))).toMatchObject({ code: "version_exists" });
    expect(await fs.readFile(versionPath("ganhuo", 1, dir), "utf8")).toBe("别人改过");
    await expect(fs.access(manifestFile())).rejects.toThrow();
  });
});

describe("意见补充提案 → 批准", () => {
  it("挂提案、同文 duplicate、批后追加到「创始人补充」生成第 2 版", async () => {
    const r = await proposeLesson({ id: "ganhuo", lesson: "开头先亮名字", founder_words: "名字要早点出", origin: { content_id: "c1", version: 3 } }, dir);
    expect(r.outcome).toBe("playbook_proposed");
    expect((await proposeLesson({ id: "ganhuo", lesson: "开头先亮名字", founder_words: "再说一次" }, dir))).toEqual({ outcome: "playbook_duplicate", proposal_id: r.proposal_id });
    const p = (await pending("ganhuo"))[0];
    expect(await approve("ganhuo", p.id, p.gen, "e-1")).toMatchObject({ ok: true, version: 2 });
    const v2 = await readVersionText("ganhuo", 2, dir);
    expect(v2).toContain("## 创始人补充\n\n- 开头先亮名字（创始人原话：「名字要早点出」）");
    expect(paragraphDiff(await readVersionText("ganhuo", 1, dir), v2)).toEqual([{ before: [], after: ["## 创始人补充", "- 开头先亮名字（创始人原话：「名字要早点出」）"] }]);
  });

  it("已有「创始人补充」一节：追加在节末，不新建第二节", () => {
    const t = appendSupplement("# 书\n\n## 创始人补充\n\n- 旧的\n", "新的", "原话");
    expect(t).toBe("# 书\n\n## 创始人补充\n\n- 旧的\n- 新的（创始人原话：「原话」）\n");
  });

  it("否决过的意见再提 → blocked_by_rejected", async () => {
    const r = await proposeLesson({ id: "renwu", lesson: "别写具名的人", founder_words: "x" }, dir);
    const p = (await pending("renwu"))[0];
    expect(await decideProposal({ id: "renwu", proposal_id: r.proposal_id, gen: p.gen, decision: "reject", eventId: "e-r", source: "tool" }, dir)).toMatchObject({ ok: true, decision: "reject" });
    expect((await proposeLesson({ id: "renwu", lesson: "别写具名的人", founder_words: "y" }, dir)).outcome).toBe("blocked_by_rejected");
    expect((await loadManifest(dir)).playbooks.find((x) => x.id === "renwu")!.current).toBe(1);
  });
});

describe("幂等、过期、冲突", () => {
  it("同一提案批两次只生效一次：同 eventId 重放，换 eventId 回 already_handled", async () => {
    await proposeLesson({ id: "shiyan", lesson: "实验先讲设定", founder_words: "x" }, dir);
    const p = (await pending("shiyan"))[0];
    const first = await approve("shiyan", p.id, p.gen, "e-1");
    expect(await approve("shiyan", p.id, p.gen, "e-1")).toMatchObject({ ok: true, replayed: true, version: first.version });
    expect(await err(approve("shiyan", p.id, p.gen, "e-2"))).toMatchObject({ code: "already_handled" });
    expect((await loadManifest(dir)).playbooks.find((x) => x.id === "shiyan")!.versions).toHaveLength(2);
  });

  it("同一 eventId 换内容（否决同一提案）→ request_conflict", async () => {
    await proposeLesson({ id: "shiyan", lesson: "实验先讲设定", founder_words: "x" }, dir);
    const p = (await pending("shiyan"))[0];
    await approve("shiyan", p.id, p.gen, "e-1");
    expect(await err(decideProposal({ id: "shiyan", proposal_id: p.id, gen: p.gen, decision: "reject", eventId: "e-1", source: "tool" }, dir))).toMatchObject({ code: "request_conflict" });
  });

  it("based_on 已过期：批准回 stale，手册内容不变", async () => {
    await proposeLesson({ id: "fanchangshi", lesson: "甲", founder_words: "x" }, dir);
    await proposeLesson({ id: "fanchangshi", lesson: "乙", founder_words: "y" }, dir);
    const [a, b] = await pending("fanchangshi");
    await approve("fanchangshi", a.id, a.gen, "e-a");
    const before = await fs.readFile(manifestFile(), "utf8");
    expect(await err(approve("fanchangshi", b.id, b.gen, "e-b"))).toMatchObject({ code: "stale" });
    const after = (await loadManifest(dir)).playbooks.find((x) => x.id === "fanchangshi")!;
    expect(after.current).toBe(2);
    expect(after.proposals.find((x) => x.id === b.id)!.status).toBe("stale");
    expect(JSON.parse(before).playbooks.find((x: { id: string }) => x.id === "fanchangshi").current).toBe(2);
  });

  it("超过 4000 字的整本修订被拒；补充会撑过上限的意见也被拒", async () => {
    expect(await err(proposeRevision({ id: "ganhuo", based_on: 1, text: "字".repeat(4001), reason: "整理", founder_words: "整理一下" }, dir))).toMatchObject({ code: "too_long" });
    expect(await err(proposeLesson({ id: "ganhuo", lesson: "长".repeat(3900), founder_words: "x" }, dir))).toMatchObject({ code: "too_long" });
    expect(await pending("ganhuo")).toHaveLength(0);
  });

  it("整本修订：based_on 不是当前版 → stale；没改动 → no_change", async () => {
    await loadManifest(dir);
    const v1 = await readVersionText("xinxicha", 1, dir);
    expect(await err(proposeRevision({ id: "xinxicha", based_on: 2, text: v1 + "x", reason: "r", founder_words: "" }, dir))).toMatchObject({ code: "stale" });
    expect(await err(proposeRevision({ id: "xinxicha", based_on: 1, text: v1, reason: "r", founder_words: "" }, dir))).toMatchObject({ code: "no_change" });
    expect(await proposeRevision({ id: "xinxicha", based_on: 1, text: v1 + "\n新段落\n", reason: "r", founder_words: "改一下" }, dir)).toMatchObject({ ok: true, based_on: 1 });
  });

  it("崩在写完 v<N>.md、提交 manifest 之前：同字节的孤儿文件被重试复用；内容不同的孤儿跳过、不碰", async () => {
    await proposeLesson({ id: "ganhuo", lesson: "甲", founder_words: "x" }, dir);
    const [a] = await pending("ganhuo");
    await fs.writeFile(versionPath("ganhuo", 2, dir), "上次没提交的别的提案");
    expect(await approve("ganhuo", a.id, a.gen, "e-1")).toMatchObject({ ok: true, version: 3 });
    expect(await fs.readFile(versionPath("ganhuo", 2, dir), "utf8")).toBe("上次没提交的别的提案");
    expect((await loadManifest(dir)).playbooks.find((x) => x.id === "ganhuo")!.current).toBe(3);
    await proposeLesson({ id: "shiyan", lesson: "乙", founder_words: "y" }, dir);
    const [b] = await pending("shiyan");
    await fs.mkdir(path.dirname(versionPath("shiyan", 2, dir)), { recursive: true });
    await fs.writeFile(versionPath("shiyan", 2, dir), b.text);
    expect(await approve("shiyan", b.id, b.gen, "e-2")).toMatchObject({ ok: true, version: 2 });
  });

  it("版本文件只写一次：目标已在且内容不同 → 拒", async () => {
    await loadManifest(dir);
    expect(await err(writeVersionOnce("ganhuo", 1, "不一样", dir))).toMatchObject({ code: "version_exists" });
  });

  it("本进程不是写入方 / 资料库没连上：报错，不写半截", async () => {
    await proposeLesson({ id: "ganhuo", lesson: "甲", founder_words: "x" }, dir);
    const p = (await pending("ganhuo"))[0];
    const before = await fs.readFile(manifestFile(), "utf8");
    vi.spyOn(roots, "assertDataDirWritable").mockImplementation(() => { throw new Error("资料库未连接"); });
    await expect(approve("ganhuo", p.id, p.gen, "e-1")).rejects.toThrow("资料库未连接");
    await expect(fs.access(versionPath("ganhuo", 2, dir))).rejects.toThrow();
    expect(await fs.readFile(manifestFile(), "utf8")).toBe(before);
  });
});

describe("回滚", () => {
  async function twoVersions() {
    await proposeLesson({ id: "ganhuo", lesson: "甲", founder_words: "x" }, dir);
    const p = (await pending("ganhuo"))[0];
    await approve("ganhuo", p.id, p.gen, "e-1");
  }
  const rb = (to: number, expected: number, request_id: string) => rollbackPlaybook({ id: "ganhuo", to_version: to, expected_current_version: expected, request_id, founder_words: "回到第一版", source: "tool" }, dir);

  it("生成新版本、历史完整；挂在当前版上的待批提案变 stale", async () => {
    await twoVersions();
    await proposeLesson({ id: "ganhuo", lesson: "乙", founder_words: "y" }, dir);
    expect(await rb(1, 2, "rq-1")).toMatchObject({ ok: true, version: 3, rolled_back_to: 1 });
    const e = (await loadManifest(dir)).playbooks.find((x) => x.id === "ganhuo")!;
    expect(e.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(e.versions[2]).toMatchObject({ kind: "rollback", author: "founder", founder_words: "回到第一版", rolled_back_to: 1, based_on: 2 });
    expect(await readVersionText("ganhuo", 3, dir)).toBe(await readVersionText("ganhuo", 1, dir));
    expect(e.proposals.find((p) => p.lesson === "乙")!.status).toBe("stale");
  });

  it("回滚到当前版本 → 报错；当前版本对不上 → stale", async () => {
    await twoVersions();
    expect(await err(rb(2, 2, "rq-1"))).toMatchObject({ code: "same_version" });
    expect(await err(rb(1, 1, "rq-2"))).toMatchObject({ code: "stale" });
  });

  it("同一 request 重试重放上次结果，不再多生成一版；同号换内容 → request_conflict", async () => {
    await twoVersions();
    const first = await rb(1, 2, "rq-1");
    expect(await rb(1, 2, "rq-1")).toMatchObject({ ok: true, replayed: true, version: first.version });
    expect((await loadManifest(dir)).playbooks.find((x) => x.id === "ganhuo")!.versions).toHaveLength(3);
    expect(await err(rb(2, 3, "rq-1"))).toMatchObject({ code: "request_conflict" });
  });
});
