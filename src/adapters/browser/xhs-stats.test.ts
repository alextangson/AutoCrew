/**
 * xhs-stats.test.ts — 小红书旁听:解析层吃 fixture(键集合按 2026-10-03 实测),翻页判定 inspect 真跑。
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { XHS_INSPECT_SRC, XHS_PAGE, XHS_PLATFORM, mapNoteRow, parseNoteList, pullXhsStats } from "./xhs-stats.js";

const fixture = (rel: string): string => readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), "utf8");
const ANALYZE = fixture("xhs/analyze-list.json");
const ANALYZE_DRIFT = fixture("xhs/analyze-list-drift.json");
const URL1 = "https://creator.xiaohongshu.com/api/galaxy/creator/datacenter/note/analyze/list?type=0&page_size=10&page_num=1";
const res = (body: string, status = 200, url = URL1) => ({ url, status, body });
type Inspect = (rs: Array<{ url: string; body: string }>) => { oldestMs: number | null; hasMore: boolean | null };
const inspect = (0, eval)(`(${XHS_INSPECT_SRC})`) as Inspect;

describe("parseNoteList(fixture 锚定)", () => {
  it("字段映射:read_count→views / fav_count→favorites,post_time 是毫秒", () => {
    const parsed = parseNoteList(res(ANALYZE));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows[0]).toMatchObject({
      title: "做一人公司的第 30 天：把复盘交给代码",
      platformItemId: "65f1a2b3000000001203e4d5",
      metrics: { views: 18422, likes: 902, favorites: 431, comments: 66, shares: 37 },
    });
    expect(parsed.rows[0].publishedAt).toBe(new Date(1783600000000).toISOString());
  });

  it("不映射 impressions/completionRate/coverClickRate —— 口径未对齐,不改对账口径", () => {
    const parsed = parseNoteList(res(ANALYZE));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows[0].metrics.impressions).toBeUndefined();
    expect(parsed.rows[0].metrics.completionRate).toBeUndefined();
    expect(parsed.rows[0].metrics.coverClickRate).toBeUndefined();
  });

  it("note_infos 改名 → schema_changed,零行(canary)", () => {
    expect(parseNoteList(res(ANALYZE_DRIFT))).toEqual({
      kind: "stop",
      result: { status: "schema_changed", rows: [], errorCode: "missing:analyze_list.data.note_infos" },
    });
  });

  it("success:false → error(带信封 code,不带 msg 原文)", () => {
    const out = parseNoteList(res('{"success":false,"code":-1,"msg":"签名校验失败"}'));
    expect(out).toMatchObject({ kind: "stop", result: { status: "error", errorCode: "analyze_list_code:-1" } });
    expect(JSON.stringify(out)).not.toContain("签名校验失败");
  });

  it("HTML 伪装 200 → schema_changed", () => {
    expect(parseNoteList(res("<!doctype html><html>"))).toMatchObject({
      kind: "stop",
      result: { status: "schema_changed", rows: [] },
    });
  });

  it("note_id 兼容字段名,标题空 → 行级校验会丢(见 pull-shared)", () => {
    expect(mapNoteRow({ note_id: "abc", read_count: 3 }).platformItemId).toBe("abc");
    expect(mapNoteRow({ id: "abc" }).metrics).toEqual({});
  });
});

describe("风控与登录", () => {
  it("HTTP 461/471 → risk_control(立即停);401 → needs_login", () => {
    expect(parseNoteList(res(ANALYZE, 461))).toMatchObject({ kind: "stop", result: { status: "risk_control", errorCode: "http:461" } });
    expect(parseNoteList(res(ANALYZE, 471))).toMatchObject({ kind: "stop", result: { status: "risk_control" } });
    expect(parseNoteList(res(ANALYZE, 401))).toMatchObject({ kind: "stop", result: { status: "needs_login" } });
  });

  it("登录页 URL 特征认 creator.xiaohongshu.com/login,不误伤数据页", () => {
    const re = new RegExp(XHS_PLATFORM.gates.loginUrl!, "i");
    expect(re.test("https://creator.xiaohongshu.com/login?source=x")).toBe(true);
    expect(re.test(XHS_PAGE)).toBe(false);
  });
});

describe("翻页(像人一样点分页器箭头)", () => {
  it("next 取 .d-pagination-page 里无文字的箭头", () => {
    expect(XHS_PLATFORM.next).toEqual({ kind: "click", css: ".d-pagination-page", texts: [] });
  });

  it("inspect:total 对比 page_num × page_size;post_time 是毫秒", () => {
    expect(inspect([res(ANALYZE)])).toEqual({ oldestMs: 1783420000000, hasMore: false });
    const big = JSON.stringify({ success: true, data: { note_infos: [], total: 25 } });
    expect(inspect([res(big)]).hasMore).toBe(true);
    expect(inspect([res(big, 200, URL1.replace("page_num=1", "page_num=3"))]).hasMore).toBe(false);
  });
});

describe("pullXhsStats 经假会话", () => {
  it("一页 → ok,标题空的行被行级校验丢掉", async () => {
    const now = () => new Date(1783600000_000 + 86_400_000);
    const session = { browse: async () => ({ pages: [{ index: 0, responses: [res(ANALYZE)] }], end: "no_more" as const, gate: null }) };
    const r = await pullXhsStats({ now, session });
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(2);
  });
});
