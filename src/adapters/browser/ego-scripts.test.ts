/**
 * ego-scripts.test.ts — 生成的旁听脚本真跑一遍（假 taskSpace / 假页面，不碰 ego lite）。
 * 锁：每页一行、碰登录/风控页立刻收手、翻页控件缺失/禁用、30 天截止、3 页上限、任何路径都 finish({ keep: [] })。
 */
import { describe, it, expect } from "vitest";
import { EGO_PAGE_MARKER, EGO_RESULT_MARKER, browseScript, finishScript, type BrowseParams } from "./ego-scripts.js";
import { WECHAT_VIDEO_PLATFORM as WV } from "./wechat-video-stats.js";

type Fn = (...args: unknown[]) => unknown;

/** 在假 ego 运行时里执行脚本，收集结果行、页行与 finish 调用 */
async function execScript(script: string, page: Record<string, unknown>, opts: { connectThrows?: boolean } = {}) {
  const lines: string[] = [];
  const finishes: unknown[] = [];
  const task = { spaceId: 42, page: () => page, finish: async (arg: unknown) => (finishes.push(arg), {}) };
  const taskSpace = async () => {
    if (opts.connectThrows) throw new Error("connect ECONNREFUSED");
    return task;
  };
  const fakeConsole = { log: (s: string) => lines.push(String(s)) };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => Fn;
  await new AsyncFunction("taskSpace", "console", "Buffer", script)(taskSpace, fakeConsole, Buffer);
  const pick = (m: string) => lines.filter((l) => l.startsWith(m)).map((l) => JSON.parse(l.slice(m.length)));
  return { results: pick(EGO_RESULT_MARKER), pages: pick(EGO_PAGE_MARKER), finishes };
}

const DAY = 86_400_000;
const NOW = Date.now();
const LIST_URL = "https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list?x=1";
const body = (daysAgo: number, more = true) =>
  JSON.stringify({ errCode: 0, data: { list: [{ createTime: Math.floor((NOW - daysAgo * DAY) / 1000) }], continueFlag: more } });

interface Sim {
  /** 每次「翻页动作」后页面会收到的响应（第 0 项是打开页面时） */
  bodies: Array<{ body: string; status?: number }>;
  href?: string;
  text?: string;
  /** 翻页控件：undefined = 找得到且可点 */
  next?: { found: boolean; disabled?: boolean };
  /** 页面菜单上看得见的文字（入口点击用） */
  menu?: string[];
  /** 什么动作会让页面收到下一条响应（默认点击） */
  serveOn?: "click" | "wheel";
}

function fakePage(sim: Sim) {
  let queue: unknown[] = [];
  let served = 0;
  const actions: string[] = [];
  const clicked: string[] = [];
  const serve = () => {
    const b = sim.bodies[served];
    if (!b) return;
    const id = `r${served}`;
    served += 1;
    queue.push({ method: "Network.responseReceived", params: { requestId: id, response: { url: LIST_URL, status: b.status ?? 201 } } });
    queue.push({ method: "Network.responseReceived", params: { requestId: `x${served}`, response: { url: "https://channels.weixin.qq.com/other", status: 200 } } });
  };
  const page = {
    cdp: async (method: string, params: { requestId?: string }) =>
      method === "Network.getResponseBody" ? { body: sim.bodies[Number(params.requestId!.slice(1))].body, base64Encoded: false } : {},
    events: async () => [queue, (queue = [])][0],
    goto: async () => (actions.push("goto"), serve(), {}),
    info: async () => ({ w: 1000, h: 800 }),
    evaluate: async (expr: string) => {
      if (expr === "location.href") return sim.href ?? WV.url;
      if (expr.startsWith("((cfg) =>")) {
        const cfg = JSON.parse(expr.slice(expr.lastIndexOf(")(") + 2, -1)) as { texts: string[] };
        if (cfg.texts.includes("下一页")) return sim.next ?? { found: true, disabled: false, x: 10, y: 20 };
        const t = cfg.texts.find((x) => (sim.menu ?? []).includes(x));
        if (t) clicked.push(t);
        return t ? { found: true, disabled: false, x: 5, y: 5 } : { found: false };
      }
      return sim.text ?? "";
    },
    mouse: {
      move: async () => void actions.push("move"),
      wheel: async () => (actions.push("wheel"), sim.serveOn === "wheel" ? serve() : undefined),
      click: async () => (actions.push("click"), sim.serveOn === "wheel" ? undefined : serve()),
    },
  };
  return { page, actions, clicked };
}

const params = (over: Partial<BrowseParams> = {}): BrowseParams => ({
  space: "n", url: WV.url, patterns: WV.patterns, gates: WV.gates, next: WV.next, inspectSrc: WV.inspectSrc,
  cutoffMs: NOW - 30 * DAY, maxPages: 3, waitMs: 400, nextWaitMs: 400, settleMs: 0, navTimeoutMs: 100, pauseMinMs: 0, pauseMaxMs: 0,
  ...over,
});

const run = async (sim: Sim, over: Partial<BrowseParams> = {}) => {
  const { page, actions, clicked } = fakePage(sim);
  return { ...(await execScript(browseScript(params(over)), page)), actions, clicked };
};

describe("browseScript — 只旁听页面自己的响应", () => {
  it("一页数据、平台说没有下一页 → 一行页数据（只含匹配的响应），end no_more，不翻页，finish 一次", async () => {
    const r = await run({ bodies: [{ body: body(1, false) }] });
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0].responses).toEqual([{ url: LIST_URL, status: 201, body: body(1, false) }]);
    expect(r.results).toEqual([{ ok: true, spaceId: 42, pages: 1, end: "no_more", gate: null }]);
    expect(r.actions).not.toContain("click");
    expect(r.finishes).toEqual([{ keep: [] }]);
  });

  it("翻满 3 页就停（点了 2 次「下一页」），每次点击前鼠标先移过去", async () => {
    const r = await run({ bodies: [{ body: body(1) }, { body: body(2) }, { body: body(3) }, { body: body(4) }] });
    expect(r.pages.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(r.results[0]).toMatchObject({ end: "max_pages", pages: 3 });
    expect(r.actions.filter((a) => a === "click")).toHaveLength(2);
    expect(r.actions.indexOf("move")).toBeLessThan(r.actions.indexOf("click"));
  });

  it("本页已出现 30 天前的作品 → 不再翻", async () => {
    const r = await run({ bodies: [{ body: body(45) }, { body: body(50) }] });
    expect(r.results[0]).toMatchObject({ end: "cutoff", pages: 1 });
    expect(r.actions).not.toContain("click");
  });

  it("翻页控件找不到 → 保留第 1 页，end pagination_missing；控件禁用 → no_more", async () => {
    expect((await run({ bodies: [{ body: body(1) }], next: { found: false } })).results[0]).toMatchObject({ end: "pagination_missing", pages: 1 });
    expect((await run({ bodies: [{ body: body(1) }], next: { found: true, disabled: true } })).results[0]).toMatchObject({ end: "no_more" });
  });

  it("点了下一页却没新响应 → end no_new_response（不算失败）", async () => {
    const r = await run({ bodies: [{ body: body(1) }] });
    expect(r.results[0]).toMatchObject({ end: "no_new_response", pages: 1 });
  });

  it("滚动翻页：鼠标移到列表上再滚轮", async () => {
    const r = await run({ bodies: [{ body: body(1) }, { body: body(2, false) }] }, { next: { kind: "scroll" } });
    expect(r.actions).toContain("wheel");
    expect(r.results[0]).toMatchObject({ pages: 1 });
  });

  it("P2-2 滚动中新的一页一到就停手：一串滚轮不会吞下好几页，每页都单独过截止与停顿", async () => {
    const r = await run({ bodies: [{ body: body(1) }, { body: body(2) }, { body: body(3, false) }], serveOn: "wheel" }, { next: { kind: "scroll" } });
    expect(r.pages.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(r.actions.filter((a) => a === "wheel")).toHaveLength(2);
    expect(r.results[0]).toMatchObject({ end: "no_more", pages: 3 });
  });

  it("P1-2 拿到数据响应时页面已在验证页 → 立刻收手，不再点翻页", async () => {
    const r = await run({ bodies: [{ body: body(1) }, { body: body(2) }], href: "https://channels.weixin.qq.com/verifycenter?captcha=1" });
    expect(r.pages).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ end: "gate", gate: "risk", pages: 1 });
    expect(r.actions).not.toContain("click");
  });

  it("P1-2 有数据但页面文字是滑块验证 → 同样收手", async () => {
    const r = await run({ bodies: [{ body: body(1) }, { body: body(2) }], text: "请拖动滑块完成验证" });
    expect(r.results[0]).toMatchObject({ end: "gate", gate: "risk" });
    expect(r.actions).not.toContain("click");
  });

  it("P2-1 响应里是终止态信封（inspect 给 terminal）→ 浏览循环里当场停，不再翻", async () => {
    const r = await run({ bodies: [{ body: body(1) }, { body: body(2) }] }, { inspectSrc: "() => ({ oldestMs: null, hasMore: true, terminal: 'login' })" });
    expect(r.results[0]).toMatchObject({ end: "gate", gate: "login", pages: 1 });
    expect(r.actions).not.toContain("click");
  });

  it("页面跳到登录页（URL 特征）→ gate login，零页，不做任何翻页动作，照样 finish", async () => {
    const r = await run({ bodies: [], href: "https://channels.weixin.qq.com/login.html" }, { waitMs: 1_500 });
    expect(r.results[0]).toMatchObject({ end: "gate", gate: "login", pages: 0 });
    expect(r.pages).toHaveLength(0);
    expect(r.actions).toEqual(["goto"]);
    expect(r.finishes).toEqual([{ keep: [] }]);
  });

  it("等不到数据、页面是滑块验证 → gate risk，立刻收手", async () => {
    const r = await run({ bodies: [], text: "请拖动下方滑块完成拼图" });
    expect(r.results[0]).toMatchObject({ end: "gate", gate: "risk" });
    expect(r.actions).toEqual(["goto"]);
  });

  it("等不到数据、也不是登录/风控页 → no_response", async () => {
    expect((await run({ bodies: [], text: "视频号助手 内容管理" })).results[0]).toMatchObject({ end: "no_response", gate: null, pages: 0 });
  });

  it("数据响应 HTTP 非 2xx（如 461）→ 这页照样交回给解析器判定，不再翻", async () => {
    const r = await run({ bodies: [{ body: "{}", status: 461 }] });
    expect(r.pages).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ end: "http_status" });
  });

  it("P1-1 入口：「发表记录」直接可见就点它进数据页，只 goto 过入口页一次", async () => {
    const entry = { css: "a,span", target: ["发表记录"], openers: ["内容管理"] };
    const r = await run({ bodies: [{ body: body(1, false) }], menu: ["发表记录"] }, { entry });
    expect(r.clicked).toEqual(["发表记录"]);
    expect(r.actions.filter((a) => a === "goto")).toHaveLength(1);
  });

  it("P1-1 入口：先点「内容管理」展开菜单再点「发表记录」", async () => {
    const entry = { css: "a,span", target: ["发表记录"], openers: ["内容管理"] };
    const { page, clicked } = fakePage({ bodies: [{ body: body(1, false) }], menu: ["内容管理"] });
    const ev = page.evaluate;
    page.evaluate = async (expr: string) => {
      if (clicked.includes("内容管理") && expr.includes("发表记录")) clicked.push("发表记录");
      if (clicked.includes("内容管理") && expr.includes("发表记录")) return { found: true, disabled: false, x: 1, y: 1 };
      return ev(expr);
    };
    const r = await execScript(browseScript(params({ entry })), page);
    expect(clicked).toEqual(["内容管理", "发表记录"]);
    expect(r.results[0]).toMatchObject({ end: "no_more", pages: 1 });
  });

  it("P1-1 入口：公众号没登录（菜单不出来、页面是登录页）→ gate login；菜单一直找不到 → entry_missing", async () => {
    const entry = { css: "a,span", target: ["发表记录"], openers: [] };
    const login = await run({ bodies: [], href: "https://mp.weixin.qq.com/", text: "使用账号登录 扫码登录" }, { entry, gates: { loginText: "扫码登录" } });
    expect(login.results[0]).toMatchObject({ end: "gate", gate: "login", pages: 0 });
    const missing = await run({ bodies: [] }, { entry });
    expect(missing.results[0]).toMatchObject({ end: "entry_missing", pages: 0 });
  });

  it("中途抛错 → 报错且只 finish 一次；连不上 → stage connect", async () => {
    const { page } = fakePage({ bodies: [] });
    const broken = { ...page, cdp: async () => Promise.reject(new Error("Network.enable failed")) };
    const r = await execScript(browseScript(params()), broken);
    expect(r.results).toMatchObject([{ ok: false, stage: "op" }]);
    expect(r.finishes).toEqual([{ keep: [] }]);
    const c = await execScript(browseScript(params()), {}, { connectThrows: true });
    expect(c.results).toMatchObject([{ ok: false, stage: "connect" }]);
  });
});

describe("finishScript", () => {
  it("关掉 TaskSpace 且不保留任何 Agent 页", async () => {
    const r = await execScript(finishScript({ space: 9 }), {});
    expect(r.finishes).toEqual([{ keep: [] }]);
  });
});
