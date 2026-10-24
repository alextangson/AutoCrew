/**
 * Phase 3 验收（三）：youtube / x 发布包按自己的 kitFields 和上限校验（按字符计），中文四平台的包校验不变。
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { chapterProblems, parseTimestamp, validateEnKit } from "./en-kit.js";
import { executeEnEdition } from "../../tools/en-edition.js";
import { executePrePublishTool } from "../../tools/pre-publish.js";
import { enSourceVideo } from "../en-edition/en-test-fixtures.js";
import { png, put, type Env } from "../production/testkit.js";

const OK_CTX = { thumbnailProblem: null, durationS: 120 };
const YT = {
  post_title: "Why max thinking effort makes AI drift",
  caption: "The harder the task, the more you want max effort. The data says otherwise.",
  tags: JSON.stringify(["AI", "Claude", "productivity"]),
  chapters: [{ at: "0:00", title: "The instinct" }, { at: "0:30", title: "The test" }, { at: "1:10", title: "What to do instead" }],
  hashtags: ["AI"],
};

describe("youtube 发布包", () => {
  it("齐全 → 通过；存下的描述 = 描述 + 章节行 + 标签", () => {
    const r = validateEnKit(YT, "youtube", OK_CTX);
    expect(r.failures).toEqual([]);
    expect(r.fields.caption).toMatch(/0:00 The instinct\n0:30 The test\n1:10 What to do instead/);
    expect(r.fields.tags).toEqual(["AI", "Claude", "productivity"]);
  });

  it("标题按字符计 ≤100（不做中文半字折算）；中文字拒；缺 tags / chapters / 缩略图逐条报", () => {
    const r = validateEnKit({ ...YT, post_title: "a".repeat(101), tags: undefined, chapters: [] }, "youtube", { thumbnailProblem: "还没有 16:9 缩略图", durationS: null });
    const fields = r.failures.map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(["post_title", "tags", "chapters", "thumbnail"]));
    expect(r.failures.find((f) => f.field === "post_title")!.detail).toMatch(/101 字符.*100/);
    expect(validateEnKit({ ...YT, post_title: "为什么 AI 会跑偏" }, "youtube", OK_CTX).failures[0].detail).toMatch(/中文/);
    expect(validateEnKit({ ...YT, post_title: "a".repeat(100) }, "youtube", OK_CTX).failures).toEqual([]);
  });

  it("章节规则：0:00 开头、≥3 章、每章 ≥10 秒、不超片长", () => {
    const ch = (xs: Array<[string, string]>) => xs.map(([at, title]) => ({ at, startS: parseTimestamp(at)!, title }));
    expect(chapterProblems(ch([["0:05", "a"], ["0:30", "b"], ["1:00", "c"]]), 120)).toEqual(expect.arrayContaining([expect.stringMatching(/0:00/)]));
    expect(chapterProblems(ch([["0:00", "a"], ["0:05", "b"], ["1:00", "c"]]), 120)).toEqual(expect.arrayContaining([expect.stringMatching(/不到 10 秒/)]));
    expect(chapterProblems(ch([["0:00", "a"], ["0:30", "b"], ["2:10", "c"]]), 120)).toEqual(expect.arrayContaining([expect.stringMatching(/超过片长/)]));
    expect(parseTimestamp("1:02:03")).toBe(3723);
  });
});

describe("x 发布包", () => {
  it("post_text ≤280 字符（标签并进去后再数）；发布标题 = 帖子正文", () => {
    const ok = validateEnKit({ post_text: "Max effort is not a free upgrade.", hashtags: ["AI"] }, "x", OK_CTX);
    expect(ok.failures).toEqual([]);
    expect(ok.fields).toMatchObject({ postTitle: "Max effort is not a free upgrade.\n\n#AI", caption: "Max effort is not a free upgrade.\n\n#AI" });
    const long = validateEnKit({ post_text: "a".repeat(279), hashtags: ["AI"] }, "x", OK_CTX);
    expect(long.failures[0]).toMatchObject({ field: "post_text", detail: expect.stringMatching(/284 字符.*280/) });
    expect(validateEnKit({}, "x", OK_CTX).failures[0].field).toBe("post_text");
  });
});

describe("经 autocrew_pre_publish video_kit 交包", () => {
  let env: Env | undefined;
  afterEach(async () => { await env?.cleanup(); env = undefined; });

  it("英文版只收勾了的英文平台；x 包按 x 的字段校验、存下", async () => {
    const src = await enSourceVideo(["douyin", "x"]);
    env = src.env;
    const d = await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: src.id });
    const id = String(d.content_id);
    const kit = (platform: string, k: unknown) => executePrePublishTool({ _dataDir: env!.dir, action: "video_kit", content_id: id, platform, kit: k });
    expect(await kit("youtube", YT)).toMatchObject({ ok: false, code: "platform_required" });
    expect(await kit("douyin", YT)).toMatchObject({ ok: false, code: "platform_required" });
    expect(await kit("x", { post_text: "a".repeat(300) })).toMatchObject({ ok: false, code: "kit_invalid" });
    const saved = await kit("x", { post_text: "Max effort is not a free upgrade.", hashtags: ["AI"] });
    expect(saved).toMatchObject({ ok: true, video_kit: { platform: "x", post_title: "Max effort is not a free upgrade.\n\n#AI" } });
  });

  it("缩略图要 16:9（按像素认）", async () => {
    const src = await enSourceVideo(["youtube"]);
    env = src.env;
    const d = await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: src.id });
    const run = (p: string) => executeEnEdition({ _dataDir: env!.dir, op: "set_thumbnail", content_id: d.content_id, path: p });
    expect(await run(await put(path.join(env.outside, "t43.png"), png(1200, 900)))).toMatchObject({ ok: false, code: "thumbnail_not_16x9" });
    expect(await run(await put(path.join(env.outside, "t169.png"), png(1280, 720)))).toMatchObject({ ok: true, thumbnail: { width: 1280, height: 720 } });
  });
});
