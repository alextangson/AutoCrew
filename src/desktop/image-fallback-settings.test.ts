/**
 * 备用生图通道链的配置解析。这里最贵的错误是「配错了但看起来存上了」——
 * 生图链只在主通道故障时才被用到,那时才发现配错已经太迟。
 */
import { describe, it, expect } from "vitest";
import { parseImageFallbacks } from "./settings.js";
import { resolveImageFallbacks, providerLabel } from "../modules/publish/wechat-mp.js";

describe("parseImageFallbacks", () => {
  it("解析一条完整的链并保序——顺序就是降级顺序", () => {
    const out = parseImageFallbacks(JSON.stringify([
      { name: "newcli", baseUrl: "https://code.newcli.com/codex/v1", apiKey: "sk-a", model: "gpt-image-2" },
      { name: "即梦", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "sk-b", dialect: "ark" },
    ]));
    expect("value" in out && out.value.map((f) => f.name)).toEqual(["newcli", "即梦"]);
    expect("value" in out && out.value[1].dialect).toBe("ark");
  });

  it("空串=空链(调用方负责区分「不改」和「清空」)", () => {
    expect(parseImageFallbacks("")).toEqual({ value: [] });
  });

  it("坏 JSON 报错要指出是 JSON 的问题,不能静默吞成空链", () => {
    const out = parseImageFallbacks("[{oops}]");
    expect("error" in out && out.error).toContain("JSON");
  });

  it("缺 apiKey 的通道被明确拒绝,并指出是第几条", () => {
    const out = parseImageFallbacks(JSON.stringify([{ baseUrl: "https://x.com/v1" }]));
    expect("error" in out && out.error).toContain("第 1 条");
    expect("error" in out && out.error).toContain("apiKey");
  });

  it("非法 dialect 被拒绝,并提示即梦该用 ark", () => {
    const out = parseImageFallbacks(JSON.stringify([{ baseUrl: "https://x.com/v1", apiKey: "k", dialect: "seedream" }]));
    expect("error" in out && out.error).toContain("ark");
  });

  it("不是数组时报错——单个对象是最容易犯的手滑", () => {
    const out = parseImageFallbacks(JSON.stringify({ baseUrl: "https://x.com/v1", apiKey: "k" }));
    expect("error" in out && out.error).toContain("数组");
  });
});

describe("resolveImageFallbacks", () => {
  it("半配的通道(缺 key)直接丢掉,不进链", () => {
    const out = resolveImageFallbacks([
      { baseUrl: "https://good.com/v1", apiKey: "k" },
      { baseUrl: "https://nokey.com/v1", apiKey: "" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("good");
  });

  it("没写 name 时用域名推,写了就用写的", () => {
    const out = resolveImageFallbacks([
      { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "k", dialect: "ark", name: "即梦" },
      { baseUrl: "https://code.newcli.com/codex/v1", apiKey: "k" },
    ]);
    expect(out.map((f) => f.name)).toEqual(["即梦", "newcli"]);
  });

  it("没配就是空链,不降级——与从前行为一致", () => {
    expect(resolveImageFallbacks(undefined)).toEqual([]);
    expect(resolveImageFallbacks([])).toEqual([]);
  });
});

describe("providerLabel", () => {
  it("即梦的火山端点认成 volces", () => {
    expect(providerLabel("https://ark.cn-beijing.volces.com/api/v3")).toBe("volces");
  });
});
