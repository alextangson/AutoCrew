import { describe, it, expect } from "vitest";
import { openclawModelParams } from "../index.js";

describe("OpenClaw 模型调用桥", () => {
  it("封面工具一律打上模型调用标记（覆盖自报值），不改认领用的 _host", () => {
    const p = openclawModelParams("autocrew_cover_review", { action: "create_candidates", _modelCall: false });
    expect(p._modelCall).toBe(true);
    expect(p._host).toBeUndefined();
  });

  it("剪辑工具也打上标记：视频稿的审片通过只许创作者点", () => {
    expect(openclawModelParams("autocrew_video", { action: "review", _modelCall: false })._modelCall).toBe(true);
  });

  it("内容工具同样打标记：剪辑之后改平台只许人来（覆盖自报值、不改原对象）", () => {
    const params = { action: "update", _modelCall: false };
    expect(openclawModelParams("autocrew_content", params)._modelCall).toBe(true);
    expect(params._modelCall).toBe(false);
  });
});
