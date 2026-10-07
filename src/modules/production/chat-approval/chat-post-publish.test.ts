/**
 * 发布后的确认在对话里定（spec 2026-10-06 proactive-chat-review，Addendum 3）：每条一个测试。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDoc } from "../../../storage/production-store.js";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { planEntry, planOf, registeredVideo, type Reg } from "../../publish/review-gate/testkit.js";
import { setPullDeps } from "../../video/handoff/pull-deps.js";
import { decideItem } from "../inbox-decide.js";
import { makeEnv, record, type Env } from "../testkit.js";
import { NO_URL, urlMismatch } from "./post-publish-view.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); setPullDeps({ benchPort: 4317 }); });
afterEach(async () => { setPullDeps(null); await env.cleanup(); });

type Item = { item_id: string; gen: string; type: string; chat_decidable: boolean; brief: string; decisions: Array<{ decision: string }>; facts: { platform: string } };
const tool = (p: Record<string, unknown>) => executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "s1", ...p });
const listed = async (type: string) => ((await tool({ action: "list" })).items as Item[]).filter((i) => i.type === type);
let rid = 0;
const decideIt = (it: Item, decision: string, extra: Record<string, unknown> = {}) =>
  tool({ action: "decide", item_id: it.item_id, gen: it.gen, decision, founder_words: "发了", request_id: `pp-${++rid}`, ...extra });
const decisions = async (id: string, type: string) => (await readProductionDoc(id, env.dir))!.decisions.filter((d) => d.type === type);
async function planned(r: Reg, platforms: string[]) {
  await fs.mkdir(path.join(r.root, "06-publish"), { recursive: true });
  await fs.writeFile(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify(planOf(r, platforms.map((p) => planEntry(r, p, ["3:4", "4:3"])))));
}
const claim = (r: Reg, extra: Record<string, unknown> = {}) => record(env, { content_id: r.id, kind: "publish", platform: "douyin", request_id: `pub-${++rid}`, ...extra }, "claude-code");

describe("publish_claim（第 1 条）", () => {
  it("brief：平台、谁说的、作品链接、依据；能定「对，发了」/「没发」", async () => {
    const r = await registeredVideo(env);
    await claim(r, { url: "https://www.douyin.com/video/123" });
    const [it0] = await listed("publish_claim");
    expect(it0.chat_decidable).toBe(true);
    expect(it0.decisions.map((d) => d.decision)).toEqual(["confirm_receipt", "correct_publish"]);
    expect(it0.brief).toContain("Claude说已经发了（抖音）");
    expect(it0.brief).toContain("作品链接：https://www.douyin.com/video/123");
    expect(it0.brief).toContain("回我「对，发了」/「没发」");
    expect(await decideIt(it0, "confirm_receipt")).toMatchObject({ ok: true, recorded_as: "chat" });
    expect((await decisions(r.id, "publish_confirm"))[0]).toMatchObject({ source: "chat", founder_words: "发了" });
  });

  it("没给链接 → 提示去平台看一眼；「没发」能记", async () => {
    const r = await registeredVideo(env);
    await claim(r, { item_id: "7400000000000000000" });
    const [it0] = await listed("publish_claim");
    expect(it0.brief).toContain(NO_URL);
    expect(await decideIt(it0, "correct_publish", { founder_words: "没发" })).toMatchObject({ ok: true });
    expect((await decisions(r.id, "publish_correction"))[0]).toMatchObject({ source: "chat", founder_words: "没发" });
  });
});

describe("published_ask（第 2 条）", () => {
  it("「发了」带作品链接原样记；链接不是这个平台的 → 拒并说原因，什么都不记", async () => {
    const r = await registeredVideo(env);
    await planned(r, ["douyin"]);
    const [it0] = await listed("published_ask");
    expect(it0.brief).toContain("发了吗（抖音）");
    const bad = await decideIt(it0, "i_published", { url: "https://www.xiaohongshu.com/explore/abc" });
    expect(bad).toMatchObject({ ok: false, code: "url_platform_mismatch", error: expect.stringContaining("不是抖音的作品链接"), item: { item_id: it0.item_id } });
    expect(await decisions(r.id, "i_published")).toHaveLength(0);
    const url = "https://v.douyin.com/AbC123/";
    expect(await decideIt(it0, "i_published", { url })).toMatchObject({ ok: true });
    expect((await decisions(r.id, "i_published"))[0]).toMatchObject({ note: url, source: "chat", founder_words: "发了" });
  });

  it("域名核对：各平台、短链、子域名、非 http", () => {
    expect(urlMismatch("douyin", "https://www.iesdouyin.com/share/video/1")).toBeNull();
    expect(urlMismatch("xiaohongshu", "http://xhslink.com/a/b")).toBeNull();
    expect(urlMismatch("wechat_video", "https://channels.weixin.qq.com/x")).toBeNull();
    expect(urlMismatch("bilibili", "https://b23.tv/x")).toBeNull();
    expect(urlMismatch("bilibili", "https://evil-bilibili.com/x")).toContain("不是");
    expect(urlMismatch("douyin", "javascript:alert(1)")).toContain("http");
  });
});

describe("「都发了」（第 3 条）", () => {
  it("列出来的几个平台各定一次，同一句原话", async () => {
    const r = await registeredVideo(env);
    await planned(r, ["douyin", "bilibili"]);
    const items = await listed("published_ask");
    expect(items).toHaveLength(2);
    for (const it of items) expect(await decideIt(it, "i_published", { founder_words: "都发了" })).toMatchObject({ ok: true });
    const ds = await decisions(r.id, "i_published");
    expect(ds.map((d) => d.platform).sort()).toEqual(["bilibili", "douyin"]);
    for (const d of ds) expect(d).toMatchObject({ source: "chat", founder_words: "都发了" });
  });
});

describe("守卫（第 4 条）", () => {
  it("代次对不上 → stale + 带 brief 的新样子；看过之后已经有人报了发布（这件没了）→ already_handled，都不记", async () => {
    const r = await registeredVideo(env);
    await planned(r, ["douyin"]);
    const [old] = await listed("published_ask");
    const stale = await decideIt({ ...old, gen: "old-gen" }, "i_published");
    expect(stale).toMatchObject({ ok: false, code: "stale" });
    expect((stale.item as Item).brief).toContain("发了吗（抖音）");
    await claim(r, { url: "https://www.douyin.com/video/9" });
    expect(await decideIt(old, "i_published")).toMatchObject({ ok: false, code: "already_handled" });
    expect(await decisions(r.id, "i_published")).toHaveLength(0);
  });

  it("网页上已经定了 → already_handled；网页那条路照旧记 founder；同一 request_id 重试回放", async () => {
    const r = await registeredVideo(env);
    await planned(r, ["douyin", "bilibili"]);
    const [a, b] = await listed("published_ask");
    expect(await decideItem({ content_id: r.id, item_id: a.item_id, gen: a.gen, action: "i_published" }, env.dir)).toMatchObject({ ok: true });
    expect((await decisions(r.id, "i_published"))[0]).toMatchObject({ source: "founder" });
    expect(await decideIt(a, "i_published")).toMatchObject({ ok: false, code: "already_handled" });
    const once = await decideIt(b, "i_published", { request_id: "same-pp" });
    expect(await decideIt(b, "i_published", { request_id: "same-pp" })).toMatchObject({ ok: true, replayed: true, decision: { id: (once.decision as { id: string }).id } });
  });
});
