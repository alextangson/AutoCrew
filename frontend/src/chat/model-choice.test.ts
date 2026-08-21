/**
 * 对话模型档位的本地记忆。重点是「陈旧值回落」这条：
 * 备用端点被删掉后，localStorage 里残留的 fallback_* 不能让切换器指向一个不存在的模型。
 */
import { describe, it, expect } from "vitest";
import {
  CHAT_MODEL_KEY, DEFAULT_CHAT_MODEL,
  groupModelOptions, modelOptionLabel, parseModelOptions, readModelChoice, writeModelChoice,
  type ChatModelOption,
} from "./model-choice";
import type { PrefStore } from "./dock-prefs";

function fakeStore(seed: Record<string, string> = {}): PrefStore & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const FULL: ChatModelOption[] = [
  { id: "fast", model: "claude-sonnet-5", tier: "快" },
  { id: "strong", model: "claude-opus-4-8", tier: "强" },
  { id: "fallback_fast", model: "deepseek-v4-flash", tier: "备用快" },
  { id: "fallback_strong", model: "deepseek-v4-pro", tier: "备用强" },
];
const PRIMARY_ONLY = FULL.slice(0, 2);
/** 自定义端点选项（Phase 4）：带 group、没有 tier */
const WITH_PROVIDERS: ChatModelOption[] = [
  ...FULL,
  { id: "p:ollama:qwen3:32b", model: "qwen3:32b", group: "本地 Ollama" },
  { id: "p:ollama:llama4", model: "llama4", group: "本地 Ollama" },
  { id: "p:kimi:kimi-k3", model: "kimi-k3", group: "Kimi" },
];

describe("readModelChoice", () => {
  it("没存过 = 缺省快档（切换器上线前的行为）", () => {
    expect(readModelChoice(FULL, fakeStore())).toBe(DEFAULT_CHAT_MODEL);
  });

  it("存过且清单里有：照旧用它", () => {
    expect(readModelChoice(FULL, fakeStore({ [CHAT_MODEL_KEY]: "fallback_strong" }))).toBe("fallback_strong");
  });

  it("陈旧值（备用端点已删）回落快档，并把存储覆写掉", () => {
    const store = fakeStore({ [CHAT_MODEL_KEY]: "fallback_strong" });
    expect(readModelChoice(PRIMARY_ONLY, store)).toBe(DEFAULT_CHAT_MODEL);
    expect(store.data[CHAT_MODEL_KEY]).toBe(DEFAULT_CHAT_MODEL);
  });

  it("手改进去的乱值同样回落", () => {
    const store = fakeStore({ [CHAT_MODEL_KEY]: "turbo" });
    expect(readModelChoice(FULL, store)).toBe(DEFAULT_CHAT_MODEL);
    expect(store.data[CHAT_MODEL_KEY]).toBe(DEFAULT_CHAT_MODEL);
  });

  it("清单为空（引擎未配置）也回落快档，不抛", () => {
    expect(readModelChoice([], fakeStore({ [CHAT_MODEL_KEY]: "strong" }))).toBe(DEFAULT_CHAT_MODEL);
  });

  it("store 不可用（隐私模式）时回缺省，不抛", () => {
    expect(readModelChoice(FULL, null)).toBe(DEFAULT_CHAT_MODEL);
    expect(() => writeModelChoice("strong", null)).not.toThrow();
  });

  it("写回后读得到", () => {
    const store = fakeStore();
    writeModelChoice("strong", store);
    expect(readModelChoice(FULL, store)).toBe("strong");
  });
});

describe("parseModelOptions / modelOptionLabel", () => {
  it("正常响应原样取出", () => {
    expect(parseModelOptions({ ok: true, data: { options: FULL } })).toEqual(FULL);
  });

  it("形状不对一律当没有可选项（切换器隐藏，不是崩）", () => {
    expect(parseModelOptions({ ok: true, data: {} })).toEqual([]);
    expect(parseModelOptions({ ok: true })).toEqual([]);
    expect(parseModelOptions(null)).toEqual([]);
    expect(parseModelOptions({ data: { options: [{ id: "fast" }, null, "x"] } })).toEqual([]);
  });

  it("选项文案 = 真实模型名 + 档位字", () => {
    expect(modelOptionLabel(FULL[0])).toBe("claude-sonnet-5 · 快");
    expect(modelOptionLabel(FULL[3])).toBe("deepseek-v4-pro · 备用强");
  });

  it("带 group 的自定义端点条目照收；tier/group 都没有的条目不算可选项", () => {
    expect(parseModelOptions({ ok: true, data: { options: WITH_PROVIDERS } })).toEqual(WITH_PROVIDERS);
    expect(parseModelOptions({ data: { options: [{ id: "p:x:m", model: "m" }] } })).toEqual([]);
  });

  it("自定义端点的文案只有模型名——optgroup 标题已经是端点名了", () => {
    expect(modelOptionLabel(WITH_PROVIDERS[4])).toBe("qwen3:32b");
  });
});

describe("groupModelOptions", () => {
  it("四档置顶不套 optgroup，自定义端点按端点名分组且保持服务端顺序", () => {
    const { plain, groups } = groupModelOptions(WITH_PROVIDERS);
    expect(plain.map((o) => o.id)).toEqual(["fast", "strong", "fallback_fast", "fallback_strong"]);
    expect(groups.map((g) => g.name)).toEqual(["本地 Ollama", "Kimi"]);
    expect(groups[0].options.map((o) => o.id)).toEqual(["p:ollama:qwen3:32b", "p:ollama:llama4"]);
  });

  it("没有自定义端点时 groups 为空（渲染与今天一模一样）", () => {
    expect(groupModelOptions(FULL).groups).toEqual([]);
    expect(groupModelOptions([]).plain).toEqual([]);
  });
});

describe("陈旧的 p:*（端点被删）", () => {
  it("清单里没有就回落快档并覆写存储——绝不指向一个不存在的端点", () => {
    const store = fakeStore({ [CHAT_MODEL_KEY]: "p:kimi:kimi-k3" });
    expect(readModelChoice(FULL, store)).toBe(DEFAULT_CHAT_MODEL);
    expect(store.data[CHAT_MODEL_KEY]).toBe(DEFAULT_CHAT_MODEL);
  });

  it("端点还在就照旧用它", () => {
    expect(readModelChoice(WITH_PROVIDERS, fakeStore({ [CHAT_MODEL_KEY]: "p:kimi:kimi-k3" }))).toBe("p:kimi:kimi-k3");
  });
});
