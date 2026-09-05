/**
 * 错误分类（P2 spec §4.2）。断的是「同一种病永远得同一个名字」——
 * 分类稳定，翻译器才敢用确定的语气说话，重试通道才不会与界面自相矛盾。
 */
import { describe, it, expect } from "vitest";
import { classifyEngineError, PROTOCOL_MISMATCH } from "./error-kind.js";
import { RetryableError } from "../utils/retry.js";

describe("classifyEngineError", () => {
  it("连接类：undici 的 fetch failed 与各种 errno 都是 connect", () => {
    for (const msg of ["fetch failed", "connect ECONNREFUSED 1.2.3.4:443", "getaddrinfo ENOTFOUND api.bad.invalid", "socket hang up"]) {
      expect(classifyEngineError(new Error(msg)).kind).toBe("connect");
    }
  });

  it("401/403 → auth，429 → rate_limit，两者的处置完全不同（换端点有没有用）", () => {
    expect(classifyEngineError(new Error('401 {"error":{"message":"invalid x-api-key"}}'))).toMatchObject({
      kind: "auth",
      status: 401,
      detail: "invalid x-api-key",
    });
    expect(classifyEngineError(new Error("429 too many requests"))).toMatchObject({ kind: "rate_limit", status: 429 });
    expect(classifyEngineError(new Error("403 forbidden")).kind).toBe("auth");
  });

  it("5xx → upstream；网关超时类状态码单独归 timeout", () => {
    expect(classifyEngineError(new Error("502 bad gateway")).kind).toBe("upstream");
    expect(classifyEngineError(new Error("504 gateway timeout")).kind).toBe("timeout");
    expect(classifyEngineError(new Error("524 origin timeout")).kind).toBe("timeout");
  });

  it("协议不匹配读的是结构化 type，不是猜字符串", () => {
    const body = JSON.stringify({ error: { type: PROTOCOL_MISMATCH, message: "端点回了 200 但不是流式响应" } });
    const c = classifyEngineError(new Error(`400 ${body}`));
    expect(c.kind).toBe("protocol");
    expect(c.status).toBe(400);
    // 同一个 400 但没有那个 type：就是普通的上游拒绝，不许被认成协议问题
    expect(classifyEngineError(new Error('400 {"error":{"message":"bad request"}}')).kind).toBe("upstream");
  });

  it("中止与超时分得开：AbortError 不是线路的病", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyEngineError(abort).kind).toBe("aborted");
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(classifyEngineError(timeout).kind).toBe("timeout");
    expect(classifyEngineError(new Error("idle timeout: no bytes for 45s")).kind).toBe("timeout");
  });

  it("我们自己写的中文超时（整稿墙钟）不算线路超时——否则给的是假诊断", () => {
    expect(classifyEngineError(new Error("脚本生成超时（600 秒整稿墙钟）：本轮作废")).kind).toBe("unknown");
  });

  it("观察器补的 502 + fetch failed body：仍是 connect，不是「上游 502」（创始人真机那句）", () => {
    const c = classifyEngineError(new Error('502: {"message":"fetch failed"}'));
    expect(c.kind).toBe("connect");
    // 真·上游 502（body 说的是别的话）照旧算 upstream
    expect(classifyEngineError(new Error('502 {"error":{"message":"upstream overloaded"}}')).kind).toBe("upstream");
  });

  it("认不出就是 unknown，绝不硬套一个分类", () => {
    expect(classifyEngineError(new Error("模型未调用 submit_script 工具")).kind).toBe("unknown");
    expect(classifyEngineError(null).kind).toBe("unknown");
  });

  it("RetryableError 带 statusCode 时按它分类（重试通道与文案同源）", () => {
    expect(classifyEngineError(new RetryableError("upstream said no", 429)).kind).toBe("rate_limit");
  });
});
