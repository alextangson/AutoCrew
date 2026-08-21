/**
 * 端点 id 生成：字符集必须与服务端 PROVIDER_ID_RE（[a-z0-9-]{1,32}）一致，
 * 且冲突时不能回一个已占用的 id——那会让两条端点在写入侧被判"重复 id"整份拒绝。
 */
import { describe, it, expect } from "vitest";
import { slugProviderId } from "./provider-id";

const VALID = /^[a-z0-9-]{1,32}$/;

describe("slugProviderId", () => {
  it("常见名字 slug 化", () => {
    expect(slugProviderId("DeepSeek")).toBe("deepseek");
    expect(slugProviderId("Kimi (Moonshot)")).toBe("kimi-moonshot");
    expect(slugProviderId("  本地 Ollama v2  ")).toBe("ollama-v2");
  });

  it("一个可用字符都没有（纯中文/纯符号/空）→ 兜底基名", () => {
    for (const name of ["深度求索", "！！！", "", "   "]) {
      expect(slugProviderId(name)).toBe("endpoint");
    }
  });

  it("冲突加后缀，且永不与已占用的重合", () => {
    expect(slugProviderId("DeepSeek", ["deepseek"])).toBe("deepseek-2");
    expect(slugProviderId("DeepSeek", ["deepseek", "deepseek-2"])).toBe("deepseek-3");
    expect(slugProviderId("深度求索", ["endpoint", "endpoint-2"])).toBe("endpoint-3");
  });

  it("超长名字截到 32 位以内，带后缀时也不越界，且不以连字符收尾", () => {
    const long = "A".repeat(40);
    expect(slugProviderId(long)).toBe("a".repeat(32));
    const withSuffix = slugProviderId(long, ["a".repeat(32)]);
    expect(withSuffix).toBe("a".repeat(30) + "-2");
    expect(withSuffix.length).toBeLessThanOrEqual(32);
  });

  it("产出永远满足服务端的 id 字符集", () => {
    for (const name of ["DeepSeek", "深度求索", "x".repeat(50), "a_b c!d", "--edge--"]) {
      expect(slugProviderId(name)).toMatch(VALID);
      expect(slugProviderId(name, [slugProviderId(name)])).toMatch(VALID);
    }
  });
});
