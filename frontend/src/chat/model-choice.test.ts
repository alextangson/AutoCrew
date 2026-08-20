/**
 * 对话模型档位的本地记忆。重点是「陈旧值回落」这条：
 * 备用端点被删掉后，localStorage 里残留的 fallback_* 不能让切换器指向一个不存在的模型。
 */
import { describe, it, expect } from "vitest";
import {
  CHAT_MODEL_KEY, DEFAULT_CHAT_MODEL,
  modelOptionLabel, parseModelOptions, readModelChoice, writeModelChoice,
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
});
