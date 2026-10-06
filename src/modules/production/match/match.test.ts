/**
 * 留下的比对小件：文件名 L1（record 的名字核对在用）与 doctor 的转写环境提示。
 */
import { describe, expect, it } from "vitest";
import { l1Strong } from "./l1.js";
import { notReadyFix } from "./transcribe.js";

describe("判定：L1 强命中（统一定义，§2.1 / §14-18）", () => {
  it("1a 的标题前缀规则与 matchL1 全标题强命中都算强命中", () => {
    expect(l1Strong("用户访谈技巧拆解.mp4", "用户访谈技巧拆解：三个坑")).toBe(true);
    expect(l1Strong("用户访谈技巧拆解三个坑-原片.mov", "用户访谈技巧拆解：三个坑")).toBe(true);
    expect(l1Strong("随便.mp4", "用户访谈技巧拆解：三个坑")).toBe(false);
  });
});

describe("doctor 的转写环境提示（§10）", () => {
  it("没就绪的三种原因各给一句怎么装", () => {
    expect(notReadyFix("未装 uv（ASR 的运行器）")).toContain("astral.sh/uv");
    expect(notReadyFix("ASR 依赖环境还没装好")).toMatch(/uv sync --project .*sidecars\/asr/);
    expect(notReadyFix("ASR 模型还没下载（约 1GB）")).toContain("预热");
  });
});
