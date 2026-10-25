/**
 * B站稿件列表旁听：解析层吃 2026-10-25 只读探查存下的脱敏样本；翻页判定（inspect）在测试里真跑。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BILIBILI_INSPECT_SRC, BILIBILI_PLATFORM, parseArchives } from "./bilibili-stats.js";
import { judgeBrowse } from "./passive-pull.js";

const BODY = readFileSync(new URL("./__fixtures__/bilibili/archives.json", import.meta.url), "utf8");
const URL_ = "https://member.bilibili.com/x/web/archives?status=is_pubing,pubed,not_pubed&pn=1&ps=10";
const r = (body: string, status = 200) => ({ url: URL_, status, body });
type Inspect = (rs: Array<{ url: string; body: string }>) => { oldestMs: number | null; hasMore: boolean | null; terminal?: string | null };
const inspect = (0, eval)(`(${BILIBILI_INSPECT_SRC})`) as Inspect;

describe("稿件列表解析", () => {
  it("bvid 当作品 id，ptime 秒 → ISO，stat 映射到播放/点赞/评论/分享/收藏", () => {
    const p = parseArchives(r(BODY));
    expect(p.kind).toBe("ok");
    if (p.kind !== "ok") return;
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0]).toEqual({
      title: "主流Agent排名：垫底的不是最难用的",
      publishedAt: "2026-10-24T10:00:00.000Z",
      platformItemId: "BV1YLn263Eqi",
      metrics: { views: 23, likes: 0, comments: 0, shares: 0, favorites: 0 },
    });
  });
  it("-101 要登录、-352 风控、其他非 0 出错、缺 arc_audits 结构变了、null = 这页没稿件", () => {
    expect(parseArchives(r(JSON.stringify({ code: -101 })))).toMatchObject({ kind: "stop", result: { status: "needs_login" } });
    expect(parseArchives(r(JSON.stringify({ code: -352 })))).toMatchObject({ kind: "stop", result: { status: "risk_control" } });
    expect(parseArchives(r(JSON.stringify({ code: 500 })))).toMatchObject({ kind: "stop", result: { status: "error" } });
    expect(parseArchives(r(JSON.stringify({ code: 0, data: {} })))).toMatchObject({ kind: "stop", result: { status: "schema_changed" } });
    expect(parseArchives(r(JSON.stringify({ code: 0, data: { arc_audits: null } })))).toEqual({ kind: "ok", rows: [] });
  });
});

describe("翻页判定", () => {
  it("最早发布时间 + pn×ps 对比 count；-101 立即收手", () => {
    expect(inspect([r(BODY)])).toEqual({ oldestMs: 1792490400000, hasMore: true, terminal: null });
    expect(inspect([r(JSON.stringify({ code: -101 }))]).terminal).toBe("login");
  });
  it("端到端判定：一页拿到，30 天内的行都留下", () => {
    const out = judgeBrowse(BILIBILI_PLATFORM, { pages: [{ index: 0, responses: [r(BODY)] }], end: "no_more", gate: null }, Date.parse("2026-09-25T00:00:00Z"));
    expect(out.status).toBe("ok");
    expect(out.rows.map((x) => x.platformItemId)).toHaveLength(3);
  });
});
