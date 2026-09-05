/**
 * 报病文案（P2 spec §4.2）。不断字面量——断的是四件事必须在场：
 * 哪条线、哪个端点（主机名）、什么故障、这次怎么顶的；以及 `fetch failed` 这类
 * 上游黑话一个字都不许漏到用户眼前。
 */
import { describe, it, expect } from "vitest";
import { classifyEngineError } from "./error-kind.js";
import { describeEngineFailure, humanizeEngineError, isEngineFailure } from "./failure-text.js";

const NEWCLI = { id: "newcli", host: "code.newcli.com" };

describe("describeEngineFailure", () => {
  it("连不上 + 没有备用：说是哪条线、哪个端点、写稿已中断，且不含 fetch failed 原文", () => {
    const text = describeEngineFailure({
      role: "writer",
      provider: NEWCLI,
      classified: classifyEngineError(new Error("fetch failed")),
      fallbackAvailable: false,
    });
    expect(text).toContain("写稿专线");
    expect(text).toContain("newcli");
    expect(text).toContain("code.newcli.com");
    expect(text).toMatch(/连不上|网络不通/);
    expect(text).toContain("没有备用端点");
    expect(text).toContain("写稿");
    expect(text).not.toContain("fetch failed");
  });

  it("限流 + 备用顶上：说清是备用顶完的，不再说「已中断」", () => {
    const text = describeEngineFailure({
      role: "main",
      provider: { id: "deepseek", host: "api.deepseek.com" },
      classified: classifyEngineError(new Error("429 rate limited")),
      fallbackUsed: { provider: "newcli" },
    });
    expect(text).toContain("主端点");
    expect(text).toContain("deepseek");
    expect(text).toContain("429");
    expect(text).toContain("备用 newcli");
    expect(text).not.toContain("已中断");
  });

  it("拒绝 Key：明说换端点没用（401 是配置问题，不是线路问题）", () => {
    const text = describeEngineFailure({
      role: "reviewer",
      provider: NEWCLI,
      classified: classifyEngineError(new Error('401 {"error":{"message":"invalid api key"}}')),
      fallbackAvailable: true,
    });
    expect(text).toContain("审稿专线");
    expect(text).toContain("code.newcli.com");
    expect(text).toContain("401");
    expect(text).toContain("换端点没用");
  });

  it("协议不匹配：给的是可执行的下一步（去设置换协议），不是 400 三个数字", () => {
    const body = JSON.stringify({ error: { type: "protocol_mismatch", message: "端点回了 200 但不是流式响应" } });
    const text = describeEngineFailure({
      role: "scout",
      provider: NEWCLI,
      classified: classifyEngineError(new Error(`400 ${body}`)),
    });
    expect(text).toContain("调研专线");
    expect(text).toContain("协议");
    expect(text).toMatch(/openai/);
  });

  it("四个角色各有各的说法，不会混成「本次调用」", () => {
    const of = (role: "writer" | "reviewer" | "scout" | "analytics") =>
      describeEngineFailure({ role, provider: NEWCLI, classified: classifyEngineError(new Error("fetch failed")) });
    expect(of("writer")).toContain("写稿专线");
    expect(of("reviewer")).toContain("审稿专线");
    expect(of("scout")).toContain("调研专线");
    expect(of("analytics")).toContain("复盘专线");
  });

  it("unknown 不套模板：调用方据此原样说，不用确定的语气说错话", () => {
    expect(isEngineFailure(classifyEngineError(new Error("模型未调用 submit_script")))).toBe(false);
    expect(isEngineFailure(classifyEngineError(new Error("fetch failed")))).toBe(true);
  });
});

describe("humanizeEngineError（原探针翻译，行为一个字不变）", () => {
  it("拆 JSON 信封，保留状态码", () => {
    expect(humanizeEngineError('429 {"error":{"message":"rate limited"}}')).toBe("429 · rate limited");
  });

  it("fetch failed 补一句人话，原文留在括号里", () => {
    const out = humanizeEngineError('502 {"error":{"message":"fetch failed"}}');
    expect(out).toContain("域名解析");
    expect(out).not.toMatch(/^502/);
  });
});

describe("describeProbeFailure（探针口）", () => {
  it("DeepSeek 风格 `401: {…}` 带冒号的信封也翻成人话，不漏 JSON", async () => {
    const { describeProbeFailure } = await import("./failure-text.js");
    const text = describeProbeFailure('401: {"message":"Authentication Fails, Your api key: ****-401 is invalid","type":"authentication_error"}', { id: "deepseek", host: "api.deepseek.com" });
    expect(text).toContain("端点 deepseek（api.deepseek.com）");
    expect(text).toContain("拒绝了 Key（401）");
    expect(text).not.toContain("{");
    expect(text).not.toContain("已中断");
  });
  it("fetch failed 归连接类，不带原文", async () => {
    const { describeProbeFailure } = await import("./failure-text.js");
    const text = describeProbeFailure('502 {"error":{"message":"fetch failed"}}', { id: "dead", host: "x.invalid" });
    expect(text).toContain("连不上");
    expect(text).not.toContain("fetch failed");
    expect(text).not.toContain("502");
  });
  it("认不出的错误退回拆信封翻译，不套模板", async () => {
    const { describeProbeFailure } = await import("./failure-text.js");
    expect(describeProbeFailure("模型未调用 submit_script", { id: "m" })).toBe("模型未调用 submit_script");
  });
});
