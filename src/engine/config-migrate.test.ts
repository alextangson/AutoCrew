import { describe, it, expect } from "vitest";
import { migrateEngineConfig } from "./config-migrate.js";
import { projectEngineConfig, sameFamilyWarning, validateEngineGraph } from "./config-validate.js";
import type { EngineConfigV2 } from "./config-schema.js";

/**
 * 创始人 2026-09-05 那份 v1（脱敏）：顶层 DeepSeek，写稿/审稿两条专线在同一家中转，
 * 备用**也**在那家中转——主线挂了备用一起挂，正是 P2 要让产品自己说出口的那件事。
 */
const FOUNDER_V1 = {
  apiKey: "sk-deepseek-main",
  baseUrl: "https://api.deepseek.com",
  strongModel: "deepseek-v4-pro",
  fastModel: "deepseek-v4-flash",
  protocol: "openai",
  routes: {
    writer: { baseUrl: "https://code.newcli.com/claude/ultra", model: "claude-opus-4-8", protocol: "anthropic", apiKey: "sk-relay" },
    reviewer: { baseUrl: "https://code.newcli.com/claude/ultra/", model: "claude-opus-4-8", protocol: "anthropic", apiKey: "sk-relay" },
    codex: { baseUrl: "https://code.newcli.com/codex/v1", model: "gpt-5.6-sol" },
  },
  fallback: {
    baseUrl: "https://code.newcli.com/claude/ultra",
    apiKey: "sk-relay",
    strongModel: "claude-opus-4-8",
    fastModel: "claude-sonnet-5",
    protocol: "anthropic",
  },
};

/** 校验通过才有 config；测试里直接取，失败时报出错误列表比 undefined 好读 */
function validated(raw: unknown, env: Record<string, string> = {}): { config: EngineConfigV2; warnings: string[] } {
  const migrated = migrateEngineConfig(raw, env);
  const outcome = validateEngineGraph(migrated.draft);
  if (!outcome.config) throw new Error(`未通过校验：${outcome.errors.join("；")}`);
  return { config: outcome.config, warnings: [...migrated.warnings, ...outcome.warnings] };
}

describe("v1 → v2 迁移", () => {
  it("创始人那份：写稿/审稿/备用三个指针落在同一条 provider 上，同家提醒进 warnings", () => {
    const { config, warnings } = validated(FOUNDER_V1);
    const relay = config.assignments?.writer?.provider;
    expect(relay).toBeTruthy();
    expect(config.assignments?.reviewer?.provider).toBe(relay);
    expect(config.fallback?.provider).toBe(relay);
    // 主端点是另一家，密钥各存一份、不再重复
    expect(config.main.provider).not.toBe(relay);
    expect(config.providers).toHaveLength(2);
    expect(config.providers.filter((p) => p.apiKey === "sk-relay")).toHaveLength(1);
    const family = warnings.find((w) => w.includes("同一家"));
    expect(family).toContain("code.newcli.com");
    expect(family).toContain("写稿专线");
  });

  it("端点 id 由主机名派生且确定：同一份配置迁两次结果一样", () => {
    const a = validated(FOUNDER_V1).config;
    const b = validated(FOUNDER_V1).config;
    expect(a.providers.map((p) => p.id)).toEqual(b.providers.map((p) => p.id));
    expect(a.providers.map((p) => p.id)).toContain("code-newcli-com");
  });

  it("模型清单是并集：同一条 provider 上写稿的 opus 与备用的 sonnet 都在", () => {
    const { config } = validated(FOUNDER_V1);
    const relay = config.providers.find((p) => p.id === config.fallback?.provider);
    expect(relay?.models).toEqual(expect.arrayContaining(["claude-opus-4-8", "claude-sonnet-5"]));
  });

  it("codex 专线丢弃并留一条 warning（生图链的 codex 通道是另一回事，不在这里）", () => {
    const { config, warnings } = validated(FOUNDER_V1);
    expect(config.assignments).not.toHaveProperty("codex");
    expect(warnings.some((w) => w.includes("codex") && w.includes("已停用"))).toBe(true);
  });

  it("协议按各自的 key/地址推断：中转 anthropic、DeepSeek openai", () => {
    const { config } = validated(FOUNDER_V1);
    const byId = new Map(config.providers.map((p) => [p.id, p] as const));
    expect(byId.get(config.main.provider)?.protocol).toBe("openai");
    expect(byId.get(config.fallback?.provider ?? "")?.protocol).toBe("anthropic");
  });

  it("没有文件、只有环境变量 → 合成一条 env 端点，主端点指向它", () => {
    const { config } = validated({}, { apiKey: "sk-env", baseUrl: "https://relay.example.com" });
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]).toMatchObject({ id: "env", apiKey: "sk-env", baseUrl: "https://relay.example.com" });
    expect(config.main.provider).toBe("env");
    expect(migrateEngineConfig({}, { apiKey: "sk-env" }).source).toBe("env");
  });

  it("什么都没有 → 主端点不成立，整份未配置（调用方走既有的未配置分支）", () => {
    const outcome = validateEngineGraph(migrateEngineConfig({}, {}).draft);
    expect(outcome.config).toBeUndefined();
    expect(outcome.errors.join()).toContain("主端点");
  });

  it("v1 的 providers 数组并入同一张表；地址+Key 撞上已有端点就合并（切换器行为不变）", () => {
    const { config, warnings } = validated({
      apiKey: "sk-main",
      baseUrl: "https://api.deepseek.com",
      providers: [
        { id: "ollama", name: "本地 Ollama", baseUrl: "http://localhost:11434/v1", apiKey: "sk-local", models: ["qwen3"] },
        { id: "same", name: "同一家", baseUrl: "https://api.deepseek.com", apiKey: "sk-main", models: ["deepseek-v4-thinking"] },
      ],
    });
    expect(config.providers.map((p) => p.id)).toEqual(["main", "ollama"]);
    expect(config.providers[0].models).toContain("deepseek-v4-thinking");
    expect(warnings.some((w) => w.includes("已合并成一个端点"))).toBe(true);
  });

  it("半配的备用（缺 Key）丢弃并说清后果", () => {
    const { config, warnings } = validated({ apiKey: "sk-main", fallback: { baseUrl: "https://api.deepseek.com" } });
    expect(config.fallback).toBeUndefined();
    expect(warnings.some((w) => w.includes("备用端点缺地址或 Key"))).toBe(true);
  });
});

describe("v2 读取与校验", () => {
  const V2 = {
    version: 2,
    providers: [
      { id: "deepseek", name: "DeepSeek 官方", baseUrl: "https://api.deepseek.com", apiKey: "sk-ds", models: ["ds-pro", "ds-flash"] },
      { id: "newcli", name: "newcli 中转", baseUrl: "https://code.newcli.com/claude/ultra", apiKey: "sk-relay", models: ["opus", "sonnet"] },
    ],
    main: { provider: "deepseek", strong: "ds-pro", fast: "ds-flash" },
    assignments: { writer: { provider: "newcli", model: "opus" } },
  };

  it("v2 文件原样读，不再迁移", () => {
    const { config, warnings } = validated(V2);
    expect(config.main.provider).toBe("deepseek");
    expect(config.assignments?.writer).toEqual({ provider: "newcli", model: "opus" });
    expect(warnings).toEqual([]);
  });

  it("悬空引用：读取路径丢弃该项并 warning，其余照常", () => {
    const { config, warnings } = validated({
      ...V2,
      fallback: { provider: "gone", strong: "x", fast: "y" },
      assignments: { writer: { provider: "gone", model: "opus" }, scout: { provider: "newcli", model: "sonnet" } },
    });
    expect(config.fallback).toBeUndefined();
    expect(config.assignments).not.toHaveProperty("writer");
    expect(config.assignments?.scout?.provider).toBe("newcli");
    expect(warnings.filter((w) => w.includes("「gone」不存在"))).toHaveLength(2);
  });

  it("main 指向不存在的端点 → 整份未配置", () => {
    const outcome = validateEngineGraph(migrateEngineConfig({ ...V2, main: { provider: "gone", strong: "a", fast: "b" } }).draft);
    expect(outcome.config).toBeUndefined();
  });

  it("模型名不在端点清单里：能用，但提醒一句", () => {
    const { warnings } = validated({ ...V2, assignments: { writer: { provider: "newcli", model: "opus-5-unlisted" } } });
    expect(warnings.some((w) => w.includes("不在端点") && w.includes("模型清单里"))).toBe(true);
  });

  it("写入口径（strict）：悬空引用是错误，不是 warning", () => {
    const draft = migrateEngineConfig({ ...V2, assignments: { writer: { provider: "gone", model: "opus" } } }).draft;
    const outcome = validateEngineGraph(draft, { strict: true });
    expect(outcome.config).toBeUndefined();
    expect(outcome.errors.join()).toContain("写稿专线");
  });

  it("同家检测：备用与写稿同主机 → 提醒；备用在别家 → 不提醒；没配备用 → 不提醒", () => {
    const base = validated(V2).config;
    expect(sameFamilyWarning(base)).toBeUndefined(); // 没配备用
    const sameHost: EngineConfigV2 = { ...base, fallback: { provider: "newcli", strong: "opus", fast: "sonnet" } };
    const warned = sameFamilyWarning(sameHost);
    expect(warned).toContain("code.newcli.com");
    expect(warned).toContain("写稿专线");
    // 同一中转的另一条路径也算同家：整站不通时一起死，这正是要抓的情形
    const otherPath: EngineConfigV2 = {
      ...sameHost,
      providers: [...base.providers, { id: "newcli2", name: "newcli codex", baseUrl: "https://code.newcli.com/codex/v1", apiKey: "sk-relay2", protocol: "openai", models: ["gpt"] }],
      fallback: { provider: "newcli2", strong: "gpt", fast: "gpt" },
    };
    expect(sameFamilyWarning(otherPath)).toContain("code.newcli.com");
    const elsewhere: EngineConfigV2 = {
      ...sameHost,
      providers: [...base.providers, { id: "other", name: "别家", baseUrl: "https://api.moonshot.cn", apiKey: "sk-k", protocol: "openai", models: ["k2"] }],
      fallback: { provider: "other", strong: "k2", fast: "k2" },
    };
    expect(sameFamilyWarning(elsewhere)).toBeUndefined();
  });
});

describe("投影成运行时配置", () => {
  it("主端点摊平成 apiKey/baseUrl/两档，备用摊平成 fallback 块，端点表整份带过去", () => {
    const { config, warnings } = validated(FOUNDER_V1);
    const runtime = projectEngineConfig(config, { dataDir: "/tmp/x", warnings });
    expect(runtime.apiKey).toBe("sk-deepseek-main");
    expect(runtime.baseUrl).toBe("https://api.deepseek.com");
    expect(runtime.strongModel).toBe("deepseek-v4-pro");
    expect(runtime.fallback).toMatchObject({ apiKey: "sk-relay", strongModel: "claude-opus-4-8", fastModel: "claude-sonnet-5" });
    expect(runtime.providers).toHaveLength(2);
    expect(runtime.activeProvider).toEqual({ id: config.main.provider, role: "main" });
    expect(runtime.warnings?.length).toBeGreaterThan(0);
    expect(runtime.version).toBe(2);
  });
});
