/**
 * Phase 3 验收（一）：派生英文版、双语脚本、对照审阅页、批脚本与改段失效、换例出处。
 * 边界：没勾 YouTube / X → 拒；只勾 X → 只有 x 发布包；源在回收站 / 成片没审 → 拒；派生两次同一条；
 * 任何一段变了批准就失效；带事实的替换例没出处 → 不能批。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { getContent } from "../../storage/local-store.js";
import { setContent, videoContent, type Env } from "../production/testkit.js";
import { loadProfile } from "../profile/creator-profile.js";
import { allowedKitPlatforms } from "../profile/platform-lines.js";
import { readInbox } from "../production/inbox-read.js";
import { decideItem } from "../production/inbox-decide.js";
import { listForChat } from "../production/chat-approval/present.js";
import { executeEnEdition } from "../../tools/en-edition.js";
import { enSourceVideo as fixtureSource, SEGMENTS } from "./en-test-fixtures.js";
import { readEnScript } from "./script.js";

let env: Env | undefined;
afterEach(async () => { await env?.cleanup(); env = undefined; });

const run = (p: Record<string, unknown>) => executeEnEdition({ _dataDir: env!.dir, ...p });
async function enSourceVideo(platforms: string[]) { const r = await fixtureSource(platforms); env = r.env; return r; }

async function derived(platforms = ["douyin", "youtube", "x"]): Promise<string> {
  const src = await enSourceVideo(platforms);
  const r = await run({ op: "derive", content_id: src.id });
  expect(r).toMatchObject({ ok: true });
  return String(r.content_id);
}

const draftItem = async (id: string) => (await readInbox(env!.dir, { withDrafts: true })).items.find((i) => i.type === "draft" && i.content_id === id)!;
const approve = async (id: string) => { const d = await draftItem(id); return decideItem({ item_id: d.item_id, gen: d.gen, action: "approve_script", content_id: id }, env!.dir); };

describe("derive：从审过的中文成片派生英文版", () => {
  it("没勾 YouTube / X → 拒", async () => {
    const src = await enSourceVideo(["douyin"]);
    expect(await run({ op: "derive", content_id: src.id })).toMatchObject({ ok: false, code: "line_not_enabled" });
  });

  it("只勾 X → 英文版落在 x，发布包也只有 x", async () => {
    const id = await derived(["douyin", "x"]);
    const c = (await getContent(id, env!.dir))!;
    expect(c.platform).toBe("x");
    expect(allowedKitPlatforms(c.platform, await loadProfile(env!.dir))).toEqual(["x"]);
  });

  it("派生两次是同一条（edition 是 JSON 字符串也认）；源在回收站 → 拒；成片没审 → 拒", async () => {
    const id = await derived();
    const again = await executeEnEdition({ _dataDir: env!.dir, edition: JSON.stringify({ op: "derive", content_id: (await getContent(id, env!.dir))!.derivedFrom!.contentId }) });
    expect(again).toMatchObject({ ok: true, created: false, content_id: id });
    const raw = await videoContent(env!, "还没剪完");
    expect(await run({ op: "derive", content_id: raw.id })).toMatchObject({ ok: false, code: "no_approved_cut" });
    await setContent(env!, raw.id, { deletedAt: new Date().toISOString() });
    expect(await run({ op: "derive", content_id: raw.id })).toMatchObject({ ok: false, code: "source_deleted" });
  });

  it("source 给成片字幕的时间槽；不是英文版的稿其他 op 一律拒", async () => {
    const id = await derived();
    const s = await run({ op: "source", content_id: id });
    expect(s.cues).toEqual([
      expect.objectContaining({ cue: 1, start_s: 0, end_s: 4 }), expect.objectContaining({ cue: 2 }),
      expect.objectContaining({ cue: 3, start_s: 8.5, end_s: 14 }), expect.objectContaining({ cue: 4, end_s: 20 }),
    ]);
    const srcId = (await getContent(id, env!.dir))!.derivedFrom!.contentId;
    expect(await run({ op: "status", content_id: srcId })).toMatchObject({ ok: false, code: "not_en_edition" });
  });
});

describe("双语脚本与批准", () => {
  it("段要按字幕顺序覆盖全部；中文原句和时间槽取自成片字幕", async () => {
    const id = await derived();
    expect(await run({ op: "set_script", content_id: id, segments: [{ cues: "2", en: "x" }] })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await run({ op: "set_script", content_id: id, segments: SEGMENTS.slice(0, 2) })).toMatchObject({ ok: false, error: expect.stringMatching(/每条都要归到/) });
    const r = await run({ op: "set_script", content_id: id, segments: JSON.stringify(SEGMENTS) });
    expect(r).toMatchObject({ ok: true, segments: 3, problems: [] });
    const script = (await readEnScript(id, env!.dir))!;
    expect(script.segments[2]).toMatchObject({ cueFrom: 3, cueTo: 4, startMs: 8500, endMs: 20000, zh: "同样的难题，同一个模型 看完数字我反而信了相反的结论" });
    expect((await getContent(id, env!.dir))!.status).toBe("draft_ready");
  });

  it("认稿那件带中英对照审阅页；批了记脚本指纹；任何一段改了批准就失效、重新进待认稿", async () => {
    const id = await derived();
    await run({ op: "set_script", content_id: id, segments: SEGMENTS });
    const list = await listForChat(env!.dir, { content_id: id });
    const item = (list.items as Array<Record<string, unknown>>).find((i) => String(i.item_id).startsWith("draft:"))!;
    expect(String(item.brief)).toMatch(/中英对照/);
    const html = await fs.readFile((item.preview as { pages: Array<{ path: string }> }).pages[0].path, "utf8");
    for (const s of ["腾讯的同事", "Tariq at Anthropic", "西方观众不熟腾讯内部", "<mark>the opposite</mark>", "槽"]) expect(html).toContain(s);
    expect(await approve(id)).toMatchObject({ ok: true });
    expect((await readEnScript(id, env!.dir))!.approval?.artifact).toBe("英文版双语脚本");
    expect((await run({ op: "status", content_id: id })).approval).toMatch(/^已批准/);
    const changed = SEGMENTS.map((s, i) => (i === 1 ? { ...s, en: "Tariq just published a test." } : s));
    await run({ op: "set_script", content_id: id, segments: changed });
    expect((await run({ op: "status", content_id: id })).approval).toMatch(/批准已失效：英文版双语脚本在批准之后变了/);
    expect(await run({ op: "dub", content_id: id })).toMatchObject({ ok: false, code: "script_not_approved" });
    expect((await getContent(id, env!.dir))!.status).toBe("draft_ready");
  });

  it("出示之后脚本变了：用旧代次批 → stale，不批新的", async () => {
    const id = await derived();
    await run({ op: "set_script", content_id: id, segments: SEGMENTS });
    const d = await draftItem(id);
    await run({ op: "set_script", content_id: id, segments: SEGMENTS.map((s, i) => (i === 0 ? { ...s, keyword: "crank it up" } : s)) });
    expect(await decideItem({ item_id: d.item_id, gen: d.gen, action: "approve_script", content_id: id }, env!.dir)).toMatchObject({ ok: false, code: "stale" });
  });

  it("带事实的替换例没有核过的出处 → unverified、不能批；标黄词不在英文里 → 不能批", async () => {
    const id = await derived();
    const bad = [SEGMENTS[0], { ...SEGMENTS[1], swaps: [{ from: "腾讯的同事", to: "Tariq at Anthropic", reason: "r", factual: "true", evidence_id: "ev-d9" }] }, { ...SEGMENTS[2], keyword: "nowhere" }];
    const r = await run({ op: "set_script", content_id: id, segments: bad });
    expect(r.problems).toEqual(expect.arrayContaining([expect.stringMatching(/unverified/), expect.stringMatching(/标黄词「nowhere」/)]));
    expect(await approve(id)).toMatchObject({ ok: false, code: "script_not_ready" });
  });
});
