import { describe, it, expect } from "vitest";
import {
  createResearchBroker,
  BrokerQuotaError,
  DEFAULT_BROKER_QUOTAS,
  normalizeWhitespace,
  type BrokerFetchImpl,
  type BrokerSearchImpl,
  type ResearchBroker,
  type ResearchBrokerDeps,
} from "./research-broker.js";
import type { ExternalPage, ImageCandidate } from "../inbox/fetch-external.js";
import type { WebSearchResult } from "./search-provider.js";

const NOW = Date.UTC(2026, 6, 26, 1, 2, 3);
const STAMP = new Date(NOW).toISOString();

type PagePreset = Partial<Omit<ExternalPage, "finalUrl">> & { finalUrl?: string };

/** 假抓取：零出网。顺带断言 broker 恒开 collectImages（素材采集不能靠调用方自觉） */
function makeFetch(presets: Record<string, PagePreset> = {}): {
  impl: BrokerFetchImpl;
  calls: string[];
} {
  const calls: string[] = [];
  const impl: BrokerFetchImpl = async (url, opts) => {
    calls.push(url);
    expect(opts.collectImages).toBe(true);
    const preset = presets[url] ?? {};
    return {
      finalUrl: preset.finalUrl ?? url,
      text: preset.text ?? `正文 ${url}`,
      ...(preset.title ? { title: preset.title } : {}),
      imageCandidates: preset.imageCandidates ?? [],
    };
  };
  return { impl, calls };
}

function makeSearch(presets: Record<string, WebSearchResult[]> = {}): {
  impl: BrokerSearchImpl;
  calls: string[];
} {
  const calls: string[] = [];
  const impl: BrokerSearchImpl = async (query) => {
    calls.push(query);
    return presets[query] ?? [{ title: `结果:${query}`, url: `https://ex.test/${encodeURIComponent(query)}`, snippet: "片段" }];
  };
  return { impl, calls };
}

function makeBroker(deps: ResearchBrokerDeps = {}): ResearchBroker {
  return createResearchBroker({
    searchImpl: makeSearch().impl,
    fetchImpl: makeFetch().impl,
    now: () => NOW,
    ...deps,
  });
}

async function quotaErrorOf(run: Promise<unknown>): Promise<BrokerQuotaError> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(BrokerQuotaError);
    return err as BrokerQuotaError;
  }
  throw new Error("expected BrokerQuotaError, but it resolved");
}

const img = (url: string): ImageCandidate => ({ url, sourceAttr: "img" });

describe("broker 配额 — 每视角一层", () => {
  it("搜索第 5 次触视角上限（默认 4）", async () => {
    const search = makeSearch();
    const b = makeBroker({ searchImpl: search.impl });
    const p = b.forPerspective("受众痛点");
    for (let i = 0; i < DEFAULT_BROKER_QUOTAS.searchPerPerspective; i++) await p.search(`词${i}`);
    const err = await quotaErrorOf(p.search("再来一次"));
    expect([err.scope, err.kind, err.limit]).toEqual(["perspective", "search", 4]);
    expect(err.message).toContain("视角「受众痛点」");
    expect(search.calls).toHaveLength(4);
  });

  it("读页第 7 次触视角上限（默认 6）", async () => {
    const fetchStub = makeFetch();
    const b = makeBroker({ fetchImpl: fetchStub.impl });
    const p = b.forPerspective("反方");
    for (let i = 0; i < DEFAULT_BROKER_QUOTAS.readPagePerPerspective; i++) {
      await p.readPage(`https://ex.test/p${i}`);
    }
    const err = await quotaErrorOf(p.readPage("https://ex.test/p99"));
    expect([err.scope, err.kind, err.limit]).toEqual(["perspective", "read_page", 6]);
    expect(fetchStub.calls).toHaveLength(6);
  });

  it("一路耗尽不影响另一路（计数按视角隔离）", async () => {
    const b = makeBroker();
    const a = b.forPerspective("A");
    for (let i = 0; i < 4; i++) await a.search(`a${i}`);
    await quotaErrorOf(a.search("a-over"));
    await expect(b.forPerspective("B").search("b0")).resolves.toMatchObject({ cached: false });
  });
});

describe("broker 配额 — 全 job 一层", () => {
  it("四路各自没超，但全 job 搜索满 14 即拦", async () => {
    const b = makeBroker();
    const names = ["A", "B", "C"];
    for (const name of names) {
      const p = b.forPerspective(name);
      for (let i = 0; i < 4; i++) await p.search(`${name}-${i}`);
    }
    const d = b.forPerspective("D");
    await d.search("D-0");
    await d.search("D-1");
    const err = await quotaErrorOf(d.search("D-2"));
    expect([err.scope, err.kind, err.limit]).toEqual(["job", "search", 14]);
    expect(b.usage().perspectives.D.search.used).toBe(2); // 本路只用了 2/4，被全局闸拦下
  });

  it("全 job 读页满 20 即拦", async () => {
    const b = makeBroker();
    for (const name of ["A", "B", "C"]) {
      const p = b.forPerspective(name);
      for (let i = 0; i < 6; i++) await p.readPage(`https://ex.test/${name}/${i}`);
    }
    const d = b.forPerspective("D");
    await d.readPage("https://ex.test/D/0");
    await d.readPage("https://ex.test/D/1");
    const err = await quotaErrorOf(d.readPage("https://ex.test/D/2"));
    expect([err.scope, err.kind, err.limit]).toEqual(["job", "read_page", 20]);
    expect(b.usage().readPage).toEqual({ used: 20, limit: 20 });
  });

  it("累计正文字节触顶后，下一次读页被拦（后置闸：越线那一页仍完整返回）", async () => {
    const text = "x".repeat(60);
    const b = makeBroker({
      quotas: { textBytesPerJob: 100 },
      fetchImpl: makeFetch({
        "https://ex.test/1": { text },
        "https://ex.test/2": { text },
        "https://ex.test/3": { text },
      }).impl,
    });
    const p = b.forPerspective("证据");
    await p.readPage("https://ex.test/1");
    const second = await p.readPage("https://ex.test/2");
    expect(second.text).toHaveLength(60); // 120 > 100，但这一页已经抓回来了，不丢
    const err = await quotaErrorOf(p.readPage("https://ex.test/3"));
    expect([err.scope, err.kind]).toEqual(["job", "text_bytes"]);
    expect(err.message).toContain("KB");
    expect(b.usage().textBytes).toEqual({ used: 120, limit: 100 });
  });

  it("抓取失败照样计配额（防止一路对着坏站反复重试）", async () => {
    const b = makeBroker({
      quotas: { readPagePerPerspective: 2 },
      fetchImpl: async () => {
        throw new Error("http_403");
      },
    });
    const p = b.forPerspective("反方");
    await expect(p.readPage("https://dead.test/a")).rejects.toThrow("http_403");
    await expect(p.readPage("https://dead.test/b")).rejects.toThrow("http_403");
    const err = await quotaErrorOf(p.readPage("https://dead.test/c"));
    expect(err.kind).toBe("read_page");
  });
});

describe("broker 缓存 — 跨视角共享且不计配额", () => {
  it("第二路读同一页命中缓存：不再出网、不计该路配额", async () => {
    const fetchStub = makeFetch({ "https://ex.test/p": { title: "标题", text: "共享正文" } });
    const b = makeBroker({ fetchImpl: fetchStub.impl });
    const first = await b.forPerspective("A").readPage("https://ex.test/p");
    const second = await b.forPerspective("B").readPage("https://ex.test/p");
    expect(fetchStub.calls).toEqual(["https://ex.test/p"]);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.text).toBe("共享正文");
    const usage = b.usage();
    expect(usage.readPage.used).toBe(1);
    expect(usage.perspectives.B.readPage.used).toBe(0);
    expect(usage.cacheHits.page).toBe(1);
  });

  it("缓存键走 URL 规范化（tracking 参数不同视为同一页）", async () => {
    const fetchStub = makeFetch();
    const b = makeBroker({ fetchImpl: fetchStub.impl });
    await b.forPerspective("A").readPage("https://ex.test/p?utm_source=x");
    const hit = await b.forPerspective("B").readPage("https://ex.test/p");
    expect(hit.cached).toBe(true);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("最终 URL 也占一个缓存位（另一路拿跳转前/后的链接都能命中）", async () => {
    const fetchStub = makeFetch({ "https://ex.test/short": { finalUrl: "https://ex.test/real" } });
    const b = makeBroker({ fetchImpl: fetchStub.impl });
    await b.forPerspective("A").readPage("https://ex.test/short");
    const hit = await b.forPerspective("B").readPage("https://ex.test/real");
    expect(hit.cached).toBe(true);
    expect(fetchStub.calls).toEqual(["https://ex.test/short"]);
  });

  it("并发撞同一页只抓一次，只计一次配额", async () => {
    const fetchStub = makeFetch();
    const b = makeBroker({ fetchImpl: fetchStub.impl });
    const [a, c] = await Promise.all([
      b.forPerspective("A").readPage("https://ex.test/same"),
      b.forPerspective("C").readPage("https://ex.test/same"),
    ]);
    expect(fetchStub.calls).toHaveLength(1);
    expect(a.sourceId).toBe(c.sourceId);
    expect(b.usage().readPage.used).toBe(1);
  });

  it("搜索缓存按归一化查询共享（大小写/空白不敏感）", async () => {
    const search = makeSearch();
    const b = makeBroker({ searchImpl: search.impl });
    const first = await b.forPerspective("A").search("  Deep   Research  ");
    const second = await b.forPerspective("B").search("deep research");
    expect(search.calls).toEqual(["Deep   Research"]);
    expect(second.cached).toBe(true);
    expect(second.results.map((r) => r.sourceId)).toEqual(first.results.map((r) => r.sourceId));
    const usage = b.usage();
    expect(usage.search.used).toBe(1);
    expect(usage.perspectives.B.search.used).toBe(0);
  });
});

describe("broker 来源登记", () => {
  it("搜索结果登记为 s*、读页登记为 p*，字段齐全", async () => {
    const b = makeBroker({
      searchImpl: makeSearch({
        q: [
          { title: "甲", url: "https://ex.test/a", snippet: "s1" },
          { title: "乙", url: "https://ex.test/b", snippet: "s2" },
        ],
      }).impl,
      fetchImpl: makeFetch({ "https://ex.test/a": { title: "甲页", finalUrl: "https://ex.test/a-final" } }).impl,
    });
    const p = b.forPerspective("A");
    const hits = await p.search("q");
    expect(hits.results.map((r) => r.sourceId)).toEqual(["s1", "s2"]);
    const page = await p.readPage("https://ex.test/a");
    expect(page.sourceId).toBe("p1");
    expect(b.getSource("p1")).toEqual({
      sourceId: "p1",
      kind: "page",
      url: "https://ex.test/a",
      finalUrl: "https://ex.test/a-final",
      title: "甲页",
      fetchedAt: STAMP,
    });
    expect(b.getSource("s1")).toMatchObject({ kind: "search_result", url: "https://ex.test/a", title: "甲" });
    expect(b.getSource("s99")).toBeNull();
    expect(b.listSources().map((s) => s.sourceId)).toEqual(["s1", "s2", "p1"]);
  });

  it("同一 URL 跨查询复用同一个 sourceId", async () => {
    const hit = [{ title: "同一篇", url: "https://ex.test/same?utm_source=a", snippet: "x" }];
    const b = makeBroker({ searchImpl: makeSearch({ q1: hit, q2: [{ ...hit[0], url: "https://ex.test/same" }] }).impl });
    const p = b.forPerspective("A");
    const first = await p.search("q1");
    const second = await p.search("q2");
    expect(second.results[0].sourceId).toBe(first.results[0].sourceId);
    expect(b.listSources()).toHaveLength(1);
  });
});

describe("broker quote 校验", () => {
  const TEXT = "第一段正文。\n\n关键数据是  87%  的用户  留存。";

  async function readied(): Promise<ResearchBroker> {
    const b = makeBroker({
      searchImpl: makeSearch({ q: [{ title: "搜到的", url: "https://ex.test/s", snippet: "片段" }] }).impl,
      fetchImpl: makeFetch({ "https://ex.test/p": { text: TEXT } }).impl,
    });
    const p = b.forPerspective("证据");
    await p.search("q");
    await p.readPage("https://ex.test/p");
    return b;
  }

  it("空白归一后子串命中（连续空白/全角空格都算）", async () => {
    const b = await readied();
    expect(b.validateQuote("p1", "关键数据是 87% 的用户 留存。")).toEqual({ ok: true });
    expect(b.validateQuote("p1", "  关键数据是　87%　的用户　留存。  ")).toEqual({ ok: true });
    expect(b.validateQuote("p1", "第一段正文。")).toEqual({ ok: true });
  });

  it("改写/转述不命中，理由是人话", async () => {
    const b = await readied();
    const check = b.validateQuote("p1", "关键数据是 87 % 的用户留存");
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("找不到");
  });

  it("search_result 不可验：明确要求先读页", async () => {
    const b = await readied();
    const check = b.validateQuote("s1", "片段");
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("证据必须来自已读页面");
  });

  it("未登记的 sourceId 与空引文各有明确理由", async () => {
    const b = await readied();
    const unknown = b.validateQuote("p9", "任意");
    const empty = b.validateQuote("p1", "   ");
    expect(unknown.ok === false && unknown.reason).toContain("未登记的来源 id");
    expect(empty.ok === false && empty.reason).toContain("引文不能为空");
  });

  it("校验语料与展示端消毒对齐：复制[链接]折叠版或原始 URL 版都命中（真实冒烟回归）", async () => {
    const b = makeBroker({
      fetchImpl: makeFetch({
        "https://ex.test/u": { text: "详见官方报告 https://example.com/report 的第三章数据。" },
      }).impl,
    });
    await b.forPerspective("证据").readPage("https://ex.test/u");
    // 模型从 read_page 看到的是消毒后的「…官方报告 [链接] 的第三章…」——逐字复制必须命中
    expect(b.validateQuote("p1", "详见官方报告 [链接] 的第三章数据。")).toEqual({ ok: true });
    // 引原始 URL 也命中：两侧走同一条消毒管线
    expect(b.validateQuote("p1", "详见官方报告 https://example.com/report 的第三章数据。")).toEqual({ ok: true });
  });
});

describe("broker 素材候选登记", () => {
  it("读页自动登记 assetId，带来源页 finalUrl", async () => {
    const b = makeBroker({
      fetchImpl: makeFetch({
        "https://ex.test/p": {
          finalUrl: "https://ex.test/p-final",
          imageCandidates: [img("https://cdn.test/1.jpg"), img("https://cdn.test/2.jpg")],
        },
      }).impl,
    });
    const page = await b.forPerspective("A").readPage("https://ex.test/p");
    expect(page.assetCandidates).toEqual([
      { assetId: "a1", url: "https://cdn.test/1.jpg" },
      { assetId: "a2", url: "https://cdn.test/2.jpg" },
    ]);
    expect(b.getAssetCandidate("a1")).toEqual({
      assetId: "a1",
      url: "https://cdn.test/1.jpg",
      sourcePageUrl: "https://ex.test/p-final",
    });
    expect(b.getAssetCandidate("a9")).toBeNull();
    expect(b.listAssetCandidates()).toHaveLength(2);
  });

  it("跨页按规范化 URL 去重，复用原 assetId", async () => {
    const b = makeBroker({
      fetchImpl: makeFetch({
        "https://ex.test/1": { imageCandidates: [img("https://cdn.test/x.jpg?utm_source=a")] },
        "https://ex.test/2": { imageCandidates: [img("https://cdn.test/x.jpg"), img("https://cdn.test/y.jpg")] },
      }).impl,
    });
    const p = b.forPerspective("A");
    await p.readPage("https://ex.test/1");
    const second = await p.readPage("https://ex.test/2");
    expect(second.assetCandidates.map((a) => a.assetId)).toEqual(["a1", "a2"]);
    expect(b.listAssetCandidates()).toHaveLength(2);
  });

  it("全 job 上限撞满就停止登记，但读页本身照样成功（素材是尽力而为）", async () => {
    const many = Array.from({ length: 5 }, (_, i) => img(`https://cdn.test/${i}.jpg`));
    const b = makeBroker({
      quotas: { assetsPerJob: 3 },
      fetchImpl: makeFetch({ "https://ex.test/p": { imageCandidates: many } }).impl,
    });
    const page = await b.forPerspective("A").readPage("https://ex.test/p");
    expect(page.assetCandidates.map((a) => a.assetId)).toEqual(["a1", "a2", "a3"]);
    expect(page.text).toContain("正文");
    expect(b.usage().assets).toEqual({ used: 3, limit: 3 });
  });
});

describe("broker usage 与视角句柄", () => {
  it("零动作的视角也出现在 usage 里（综合阶段要点名谁没用配额）", () => {
    const b = makeBroker();
    b.forPerspective("受众痛点");
    b.forPerspective("对标");
    expect(Object.keys(b.usage().perspectives)).toEqual(["受众痛点", "对标"]);
    expect(b.usage().perspectives.对标).toEqual({
      search: { used: 0, limit: 4 },
      readPage: { used: 0, limit: 6 },
    });
  });

  it("同名句柄共享计数", async () => {
    const b = makeBroker();
    await b.forPerspective("A").search("q1");
    await b.forPerspective("A").search("q2");
    expect(b.usage().perspectives.A.search.used).toBe(2);
  });

  it("usage 汇总全 job 各配额的已用/上限", async () => {
    const b = makeBroker({
      fetchImpl: makeFetch({ "https://ex.test/p": { text: "abcd", imageCandidates: [img("https://cdn.test/1.jpg")] } }).impl,
    });
    const p = b.forPerspective("A");
    await p.search("q");
    await p.readPage("https://ex.test/p");
    expect(b.usage()).toMatchObject({
      search: { used: 1, limit: 14 },
      readPage: { used: 1, limit: 20 },
      textBytes: { used: 4, limit: 300 * 1024 },
      assets: { used: 1, limit: 40 },
      sources: 2,
      cacheHits: { search: 0, page: 0 },
    });
  });

  it("空查询/空链接直接报错，不浪费配额", async () => {
    const b = makeBroker();
    const p = b.forPerspective("A");
    await expect(p.search("   ")).rejects.toThrow("搜索词不能为空");
    await expect(p.readPage("  ")).rejects.toThrow("读页链接不能为空");
    expect(b.usage().perspectives.A).toEqual({
      search: { used: 0, limit: 4 },
      readPage: { used: 0, limit: 6 },
    });
  });
});

describe("normalizeWhitespace", () => {
  it("全角空格与连续空白折成单个半角空格，首尾去空", () => {
    expect(normalizeWhitespace("　中文　 空白\n\t 折叠　")).toBe("中文 空白 折叠");
    expect(normalizeWhitespace("a b")).toBe("a b");
  });
});
