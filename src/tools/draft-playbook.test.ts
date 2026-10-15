/** 写稿接手册（spec 2026-10-13 §2、§8、§9.4/9.5/9.8）：genre 必填、版本钉住、旧稿照常续写、手册类意见进提案 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickOpening } from "./draft-test-helpers.js";
import { executeDraft } from "./draft.js";
import { executePlaybook } from "./playbook.js";
import { getContent, updateContent } from "../storage/local-store.js";
import { decideProposal } from "../modules/playbook/changes.js";
import { loadManifest } from "../modules/playbook/store.js";
import { PLAYBOOK_IDS } from "../modules/playbook/types.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-playbook-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const BODY = "你是不是也觉得用了 AI 以后反而更忙了？我先说结论：省下来的时间，被你自己又填满了。可周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的时间写进日历，标成不许约会。";
const ANGLE = { exemplars: [] as unknown[], main_line: "AI 省下的时间会被你自己填满", for_whom: "职场人", opening: "深度思考开到 max", why_viral: "没有数字", chain: ["一", "二", "三", "四"], founder_words: "就这个" };
const run = (action: string, args: Record<string, unknown> = {}) => executeDraft({ action, ...args, _dataDir: dir, _host: "claude-code", _session: "s1" });
const pb = (args: Record<string, unknown>) => executePlaybook({ ...args, _dataDir: dir, _host: "claude-code", _session: "s1" });
const newDraft = async () => (await run("start", { inspiration: "用了 AI 反而更忙" })).content_id as string;

/** 让干货方法手册升到第 2 版 */
async function bumpGanhuo(): Promise<void> {
  const cur = await pb({ action: "get", id: "ganhuo" });
  const prop = await pb({ action: "propose", id: "ganhuo", based_on: cur.version, text: `${String(cur.text)}\n新的一段。\n`, reason: "补一段", founder_words: "整理一下" });
  await decideProposal({ id: "ganhuo", proposal_id: String(prop.proposal_id), gen: String(prop.gen), decision: "approve", eventId: "bump-1", source: "tool" }, dir);
}

describe("start", () => {
  it("带 5 本的索引（名称、什么时候选它、当前版本），不带全文和 craft_method", async () => {
    const r = await run("start", { inspiration: "灵感" }) as { context: Record<string, unknown> };
    const idx = r.context.playbooks_index as Array<Record<string, unknown>>;
    expect(idx.map((x) => x.id)).toEqual([...PLAYBOOK_IDS]);
    expect(idx.every((x) => x.version === 1 && String(x.when_to_choose).length > 20 && !("text" in x))).toBe(true);
    expect(r.context).not.toHaveProperty("craft_method");
  });

  it("手册清单坏了：start 照样回，带 playbooks_error（看得见，不当空）", async () => {
    await loadManifest(dir);
    await fs.writeFile(path.join(dir, "playbooks", "manifest.json"), "坏");
    const r = await run("start", { inspiration: "灵感" }) as { ok: boolean; context: Record<string, unknown> };
    expect(r.ok).toBe(true);
    expect(String(r.context.playbooks_error)).toContain("解析失败");
  });
});

describe("angle 的 genre", () => {
  it("新立意不带 genre / 写错 → 拒，回执列出 5 个合法 id", async () => {
    const id = await newDraft();
    expect(await run("angle", { content_id: id, base_version: 1, ...ANGLE })).toMatchObject({ ok: false, code: "bad_param", genres: [...PLAYBOOK_IDS] });
    expect(await run("angle", { content_id: id, base_version: 1, ...ANGLE, genre: "dry" })).toMatchObject({ ok: false, code: "bad_genre", genres: [...PLAYBOOK_IDS] });
    expect((await getContent(id, dir))!.draftPath!.angle).toBeUndefined();
  });

  it("记下版本、回执带全文；手册升级后续写 / 重出同体裁立意 / prepare_final 都不换；换体裁记新体裁的当前版", async () => {
    const id = await newDraft();
    const a = await run("angle", { content_id: id, base_version: 1, ...ANGLE, genre: "GANHUO" });
    expect(a).toMatchObject({ ok: true, playbook: { id: "ganhuo", version: 1, name: "干货方法" } });
    expect(String((a.playbook as { text: string }).text)).toContain("# 干货方法");
    await bumpGanhuo();
    const resumed = await run("start", { content_id: id }) as { progress: { playbook: { version: number; text: string } } };
    expect(resumed.progress.playbook.version).toBe(1);
    expect(resumed.progress.playbook.text).not.toContain("新的一段");
    expect(await run("angle", { content_id: id, base_version: 1, ...ANGLE, genre: "ganhuo", founder_words: "再来" })).toMatchObject({ playbook: { version: 1 } });
    await pickOpening(run, id, 1);
    expect((await run("save", { content_id: id, base_version: 1, body: BODY })).ok).toBe(true);
    expect((await run("prepare_final", { content_id: id, base_version: 2, citations: [] })).ok).toBe(true);
    expect((await getContent(id, dir))!.draftPath!.angle!.playbook).toEqual({ id: "ganhuo", version: 1 });
    expect(await run("angle", { content_id: id, base_version: 2, ...ANGLE, genre: "shiyan" })).toMatchObject({ playbook: { id: "shiyan", version: 1 } });
    expect(await run("angle", { content_id: id, base_version: 2, ...ANGLE, genre: "ganhuo" })).toMatchObject({ playbook: { id: "ganhuo", version: 2 } });
  });

  it("旧稿：立意没记版本 → 未归版本，照常续写和存稿", async () => {
    const id = await newDraft();
    await run("angle", { content_id: id, base_version: 1, ...ANGLE, genre: "ganhuo" });
    await pickOpening(run, id, 1);
    const c = (await getContent(id, dir))!;
    const { playbook: _drop, ...legacy } = c.draftPath!.angle!;
    await updateContent(id, { draftPath: { ...c.draftPath!, angle: legacy } }, dir);
    const r = await run("start", { content_id: id }) as { ok: boolean; progress: Record<string, unknown> };
    expect(r.ok).toBe(true);
    expect(r.progress.playbook).toBeNull();
    expect(String(r.progress.playbook_note)).toContain("未归版本");
    expect((await run("save", { content_id: id, base_version: 1, body: BODY })).ok).toBe(true);
  });
});

describe("手册类意见（scope playbook:<id>）", () => {
  async function written(): Promise<string> {
    const id = await newDraft();
    await run("angle", { content_id: id, base_version: 1, ...ANGLE, genre: "ganhuo" });
    await pickOpening(run, id, 1);
    await run("save", { content_id: id, base_version: 1, body: BODY });
    return id;
  }
  const lesson = (scope: string, relation = "new") => ({ founder_words: "名字要早点出", lessons: [{ rule: "干货稿开头先亮机制的名字", scope, relation }] });

  it("2026-10-15 起不即时挂提案：lessons 原样留在意见里，回执带看得见的说明；意见记录带当时的手册版本", async () => {
    const id = await written();
    const r = await run("save", { content_id: id, base_version: 2, body: BODY + "就这一件事。", feedback: lesson("playbook:ganhuo") });
    expect(r).toMatchObject({ ok: true, lessons_note: expect.stringContaining("定稿时跨稿比对") });
    expect(r.lessons).toBeUndefined();
    const again = await run("save", { content_id: id, base_version: 3, body: BODY + "就这两件事。", feedback: JSON.stringify(lesson("playbook:ganhuo")) });
    expect(again.lessons_note).toBeTruthy();
    const c = (await getContent(id, dir))!;
    const body = c.draftPath!.feedback!.filter((f) => f.stage === "body");
    expect(body.map((f) => f.playbook)).toEqual([{ id: "ganhuo", version: 1 }, { id: "ganhuo", version: 1 }]);
    expect(body[0].deferred_lessons).toEqual([expect.objectContaining({ rule: "干货稿开头先亮机制的名字", scope: "playbook:ganhuo" })]);
    expect((await pb({ action: "list" })).playbooks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ganhuo", pending_proposals: 0 })]));
    const fin = await run("prepare_final", { content_id: id, base_version: 4, citations: [] });
    expect(fin.pending_lessons).toEqual([]);
  });

  it("conflict 关系、不认识的体裁 → 拒，这一版不存", async () => {
    const id = await written();
    expect(await run("save", { content_id: id, base_version: 2, body: BODY + "x。", feedback: lesson("playbook:ganhuo", "conflict") })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("save", { content_id: id, base_version: 2, body: BODY + "x。", feedback: lesson("playbook:nope") })).toMatchObject({ ok: false, code: "bad_param" });
  });
});

describe("autocrew_playbook 工具", () => {
  it("list / get；id 写错列出合法 id；rollback 参数可以是字符串数字", async () => {
    expect((await pb({ action: "list" })).playbooks).toHaveLength(5);
    expect(await pb({ action: "get", id: "x" })).toMatchObject({ ok: false, code: "bad_genre", ids: [...PLAYBOOK_IDS] });
    await bumpGanhuo();
    const got = await pb({ action: "get", id: "ganhuo", version: "1" });
    expect(got).toMatchObject({ ok: true, version: 1, current_version: 2 });
    expect(await pb({ action: "rollback", id: "ganhuo", to_version: "1", expected_current_version: "2", founder_words: "回滚", request_id: "r-1" })).toMatchObject({ ok: true, version: 3 });
    expect(await pb({ action: "rollback", id: "ganhuo", to_version: 1, expected_current_version: 2 })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await pb({ action: "propose", id: "ganhuo", based_on: 3, text: "字".repeat(4001), reason: "r" })).toMatchObject({ ok: false, code: "too_long" });
  });
});
