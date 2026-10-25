import { afterEach, describe, it, expect, vi } from "vitest";
import {
  RECHECK_TICK_MS,
  STALE_FAILURE_MS,
  startStaleRecheck,
  assignmentSummary,
  engineBannerLines,
  fallbackTitle,
  hasStaleFailure,
  latestRecord,
  providerDot,
  providerPayload,
  referencedProviderIds,
  referrersOf,
  toProviderRows,
  type EngineHealthView,
  type HealthProvider,
} from "./engine-lib";

const T0 = Date.parse("2026-09-05T10:00:00.000Z");

function provider(over: Partial<HealthProvider> = {}): HealthProvider {
  return { id: "deepseek", name: "DeepSeek 官方", host: "api.deepseek.com", probe: null, live: null, ...over };
}

function view(over: Partial<EngineHealthView> = {}): EngineHealthView {
  return {
    configured: true,
    providers: [provider()],
    main: { provider: "deepseek", strong: "v4-pro", fast: "v4-flash" },
    fallback: null,
    assignments: { writer: null, reviewer: null, scout: null, analytics: null },
    warnings: [],
    ...over,
  };
}

describe("latestRecord / providerDot", () => {
  it("没探过也没跑过 = 未测,不是坏", () => {
    expect(latestRecord({ probe: null, live: null })).toBeNull();
    expect(providerDot({ probe: null, live: null })).toMatchObject({ tone: "idle", text: "未测" });
  });

  it("只有探针成功 → 通 + 耗时", () => {
    const dot = providerDot({ probe: { at: "2026-09-05T09:59:00.000Z", ok: true, ms: 1523 }, live: null });
    expect(dot.tone).toBe("ok");
    expect(dot.text).toBe("通 · 1.5s");
  });

  it("探针失败在前、真实调用成功在后 → 现在是通的（取最近的,不取最坏的）", () => {
    const dot = providerDot({
      probe: { at: "2026-09-05T09:00:00.000Z", ok: false, ms: 0, error: "连不上" },
      live: { at: "2026-09-05T09:59:00.000Z", ok: true, role: "writer" },
    });
    expect(dot.tone).toBe("ok");
  });

  it("真实调用最新且失败 → 坏 · 原因,hover 给全文", () => {
    const reason = "写稿专线 newcli（code.newcli.com）连不上：网络不通或域名解析失败。这次没有备用端点，写稿已中断。";
    const dot = providerDot({
      probe: { at: "2026-09-05T09:00:00.000Z", ok: true, ms: 800 },
      live: { at: "2026-09-05T09:59:00.000Z", ok: false, role: "writer", error: reason },
    });
    expect(dot.tone).toBe("bad");
    expect(dot.text.startsWith("坏 · ")).toBe(true);
    expect(dot.title).toBe(reason);
  });
});

describe("referrersOf / referencedProviderIds", () => {
  const pointers = {
    main: { provider: "deepseek", strong: "s", fast: "f" },
    fallback: { provider: "newcli", strong: "s", fast: "f" },
    assignments: { writer: { provider: "newcli", model: "opus" }, reviewer: null, scout: null, analytics: null },
  };

  it("列出全部引用者（删除拒绝要照着念）", () => {
    expect(referrersOf("newcli", pointers)).toEqual(["备用端点", "写稿专线"]);
    expect(referrersOf("deepseek", pointers)).toEqual(["主端点"]);
  });

  it("没人用的端点没有引用者 → 可以删", () => {
    expect(referrersOf("ollama", pointers)).toEqual([]);
  });

  it("被引用的端点 id 去重", () => {
    expect(referencedProviderIds(pointers)).toEqual(["deepseek", "newcli"]);
  });
});

describe("assignmentSummary", () => {
  it("一个都没配 = 全部跟随主端点", () => {
    expect(assignmentSummary({ writer: null, reviewer: null, scout: null, analytics: null })).toBe("4 个岗位全部跟随主端点");
  });

  it("配了两个 → 点名 + 其余跟随", () => {
    const s = assignmentSummary({
      writer: { provider: "newcli", model: "opus" },
      reviewer: { provider: "newcli", model: "opus" },
      scout: null,
      analytics: null,
    });
    expect(s).toBe("写稿、审稿 → newcli；其余跟随主端点");
  });

  it("四个全配同一家 → 不再说「其余」", () => {
    const a = { provider: "newcli", model: "opus" };
    expect(assignmentSummary({ writer: a, reviewer: a, scout: a, analytics: a })).toBe("写稿、审稿、调研、复盘 → newcli");
  });
});

describe("engineBannerLines", () => {
  it("未配置 → 不出横幅（那是首次开机卡的活）", () => {
    expect(engineBannerLines(view({ configured: false }), T0)).toEqual([]);
  });

  it("全都没探过 → 不出横幅", () => {
    expect(engineBannerLines(view(), T0)).toEqual([]);
  });

  it("写稿专线坏了且没有备用 → 说清哪条线、多久之前、写稿会失败", () => {
    const lines = engineBannerLines(
      view({
        providers: [
          provider(),
          provider({ id: "newcli", name: "newcli 中转", host: "code.newcli.com", live: { at: "2026-09-05T09:57:00.000Z", ok: false, role: "writer", error: "写稿专线 newcli（code.newcli.com）连不上" } }),
        ],
        assignments: { writer: { provider: "newcli", model: "opus" }, reviewer: null, scout: null, analytics: null },
      }),
      T0,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].providerId).toBe("newcli");
    expect(lines[0].text).toContain("写稿专线");
    expect(lines[0].text).toContain("3 分钟前");
    expect(lines[0].text).toContain("没有备用端点，写稿会失败。");
  });

  it("有健康的备用 → 说下次由谁顶上", () => {
    const lines = engineBannerLines(
      view({
        providers: [
          provider({ live: { at: "2026-09-05T09:59:30.000Z", ok: false, role: "chat", error: "主端点限流（429）" } }),
          provider({ id: "newcli", name: "newcli", host: "code.newcli.com", probe: { at: "2026-09-05T09:58:00.000Z", ok: true, ms: 700 } }),
        ],
        fallback: { provider: "newcli", strong: "opus", fast: "sonnet" },
      }),
      T0,
    );
    expect(lines[0].text).toContain("下次");
    expect(lines[0].text).toContain("将由备用 newcli 顶上。");
  });

  it("备用自己也坏了 → 明说会失败,不许承诺兜底", () => {
    const lines = engineBannerLines(
      view({
        providers: [
          provider({ live: { at: "2026-09-05T09:59:30.000Z", ok: false, role: "chat", error: "主端点连不上" } }),
          provider({ id: "newcli", name: "newcli", host: "code.newcli.com", probe: { at: "2026-09-05T09:58:00.000Z", ok: false, ms: 0, error: "连不上" } }),
        ],
        fallback: { provider: "newcli", strong: "opus", fast: "sonnet" },
      }),
      T0,
    );
    expect(lines.map((l) => l.providerId)).toEqual(["deepseek", "newcli"]);
    expect(lines[0].text).toContain("备用 newcli 也不通");
  });

  it("坏的端点没人引用 → 不打扰用户", () => {
    const lines = engineBannerLines(
      view({
        providers: [provider(), provider({ id: "ollama", name: "本地", host: "127.0.0.1", probe: { at: "2026-09-05T09:00:00.000Z", ok: false, ms: 0, error: "连不上" } })],
      }),
      T0,
    );
    expect(lines).toEqual([]);
  });
});

describe("端点表表单", () => {
  it("settings:get → 表单行：models 摊成逗号串,key 一律空（留空 = 保持现状）", () => {
    const rows = toProviderRows([
      { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", protocol: null, models: ["a", "b"], apiKeySet: true },
    ]);
    expect(rows[0]).toMatchObject({ id: "deepseek", models: "a, b", apiKey: "", apiKeySet: true, savedModels: ["a", "b"] });
  });

  it("表单行 → 提交体：空 key 不提交（保留已存的那把）", () => {
    const payload = providerPayload([
      { key: "k", id: "deepseek", name: " DeepSeek ", baseUrl: " https://api.deepseek.com ", models: "a，b  c", protocol: "", apiKey: "  ", apiKeySet: true, savedModels: [] },
    ]);
    expect(payload[0]).toEqual({ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", models: ["a", "b", "c"] });
  });

  it("填了新 key / 显式协议就带上", () => {
    const payload = providerPayload([
      { key: "k", id: "x", name: "X", baseUrl: "https://x.dev", models: "m", protocol: "anthropic", apiKey: " sk-1 ", apiKeySet: false, savedModels: [] },
    ]);
    expect(payload[0]).toMatchObject({ protocol: "anthropic", apiKey: "sk-1" });
  });
});

describe("fallbackTitle", () => {
  it("说得出哪条线、主线为什么失败、这次谁顶的", () => {
    const t = fallbackTitle({ role: "writer", from: "claude-opus-4-8", to: "deepseek-v4-pro", error: "429 rate limited" });
    expect(t).toContain("写稿专线");
    expect(t).toContain("claude-opus-4-8");
    expect(t).toContain("429");
    expect(t).toContain("deepseek-v4-pro");
  });
});


describe("stripRoleAndOutcome", () => {
  it("去掉角色前缀与「已中断」尾句，中间的病因原样保留", async () => {
    const { stripRoleAndOutcome } = await import("./engine-lib.js");
    expect(stripRoleAndOutcome("主端点 dead（x.invalid）连不上：网络不通或域名解析失败。本次调用已中断。")).toBe("dead（x.invalid）连不上：网络不通或域名解析失败。");
    expect(stripRoleAndOutcome("端点 a（h）拒绝了 Key（401）：Key 错误或已过期，换端点没用。")).toBe("a（h）拒绝了 Key（401）：Key 错误或已过期，换端点没用。");
    expect(stripRoleAndOutcome("写稿专线 r（h）限流（429）：请求太密或额度用尽。这次没有备用端点，写稿已中断。")).toBe("r（h）限流（429）：请求太密或额度用尽。");
  });
});

describe("startStaleRecheck：红点挂着就一直打节拍，不靠重渲染", () => {
  // 模拟后端 recheckProviders：只探过时 5 分钟以上的失败；探失败刷新失败时间，探通则清掉
  function fakeBackend(probeOk: () => boolean) {
    let failedAt: number | null = Date.now();
    let probes = 0;
    const tick = () => {
      if (failedAt === null || Date.now() - failedAt <= STALE_FAILURE_MS) return;
      probes++;
      failedAt = probeOk() ? null : Date.now();
    };
    return { tick, probes: () => probes, cleared: () => failedAt === null };
  }

  afterEach(() => vi.useRealTimers());

  it("刚失败：没有任何别的渲染，过时后照样被探到并清掉", () => {
    vi.useFakeTimers();
    const b = fakeBackend(() => true);
    const stop = startStaleRecheck(b.tick);
    expect(b.probes()).toBe(0); // 刚失败不探
    vi.advanceTimersByTime(STALE_FAILURE_MS + RECHECK_TICK_MS);
    expect(b.probes()).toBe(1);
    expect(b.cleared()).toBe(true);
    stop();
  });

  it("复探失败刷新了时间：节拍不停，之后还会继续探", () => {
    vi.useFakeTimers();
    const b = fakeBackend(() => false);
    const stop = startStaleRecheck(b.tick);
    vi.advanceTimersByTime(30 * 60_000);
    expect(b.probes()).toBeGreaterThanOrEqual(4);
    stop();
    const before = b.probes();
    vi.advanceTimersByTime(30 * 60_000);
    expect(b.probes()).toBe(before); // 停表后不再打
  });
});

describe("上次检查与过时判定（顶栏红点只反映现在）", () => {
  const failed = (at: string) => view({ providers: [provider({ live: { at, ok: false, role: "scout", error: "调研专线 deepseek（api.deepseek.com）连不上：网络不通或域名解析失败。调研已中断。" } })] });

  it("文案带「上次检查：X 前」，且保留「没有备用端点」的提醒", () => {
    const [line] = engineBannerLines(failed("2026-09-05T08:00:00.000Z"), T0);
    expect(line.text).toContain("上次检查：2 小时前。");
    expect(line.text).toContain("没有备用端点");
    expect(line.checkedAt).toBe("2026-09-05T08:00:00.000Z");
  });

  it("失败过了 5 分钟算过时（该复探），刚失败的不算", () => {
    expect(hasStaleFailure(engineBannerLines(failed("2026-09-05T08:00:00.000Z"), T0), T0)).toBe(true);
    expect(hasStaleFailure(engineBannerLines(failed("2026-09-05T09:58:00.000Z"), T0), T0)).toBe(false);
  });

  it("复探通了（更新的成功 probe）→ 红点消失", () => {
    const v = view({ providers: [provider({ live: { at: "2026-09-05T08:00:00.000Z", ok: false, role: "scout", error: "连不上" }, probe: { at: "2026-09-05T09:59:00.000Z", ok: true, ms: 200 } })] });
    expect(engineBannerLines(v, T0)).toEqual([]);
  });
});
