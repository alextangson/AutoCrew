import { describe, it, expect } from "vitest";
import { encodeFrame, createFrameDecoder, parseBridgeMessage } from "./protocol.js";
import type { BridgeMessage } from "./protocol.js";

// ─── encodeFrame / createFrameDecoder ───────────────────────────────────────

describe("encodeFrame + createFrameDecoder round-trip", () => {
  it("round-trips a simple object", () => {
    const msg = { type: "ping" };
    const dec = createFrameDecoder();
    const results = dec.feed(encodeFrame(msg));
    expect(results).toEqual([msg]);
  });

  it("round-trips a message with Chinese and emoji", () => {
    const msg = { type: "ingest_rows", platform: "抖音🎬", rows: [{ 作品名称: "测试视频🔥" }] };
    const dec = createFrameDecoder();
    expect(dec.feed(encodeFrame(msg))).toEqual([msg]);
  });

  it("handles partial (half-packet) across two feeds", () => {
    const msg = { type: "ping" };
    const full = encodeFrame(msg);
    const half = Math.floor(full.length / 2);
    const dec = createFrameDecoder();
    expect(dec.feed(full.subarray(0, half))).toEqual([]);
    expect(dec.feed(full.subarray(half))).toEqual([msg]);
  });

  it("handles two messages in one chunk (粘包)", () => {
    const m1 = { type: "ping" };
    const m2 = { type: "ingest_rows", platform: "douyin", rows: [] };
    const combined = Buffer.concat([encodeFrame(m1), encodeFrame(m2)]);
    const dec = createFrameDecoder();
    expect(dec.feed(combined)).toEqual([m1, m2]);
  });

  it("decodes a frame fed byte-at-a-time (长度前缀本身跨 chunk 撕裂)", () => {
    const msg = { type: "ingest_rows", platform: "douyin", rows: [{ 作品名称: "测试" }] };
    const full = encodeFrame(msg);
    const dec = createFrameDecoder();
    const results: unknown[] = [];
    for (let i = 0; i < full.length; i++) {
      results.push(...dec.feed(full.subarray(i, i + 1)));
    }
    expect(results).toEqual([msg]);
  });

  it("rejects a frame whose declared length exceeds 10 MB", () => {
    // build a fake header declaring 11 MB
    const tooLarge = 11 * 1024 * 1024;
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(tooLarge, 0);
    const dec = createFrameDecoder();
    expect(() => dec.feed(buf)).toThrow(/超过/);
  });

  it("throws on invalid JSON body", () => {
    const bad = Buffer.from("not-json");
    const frame = Buffer.alloc(4 + bad.length);
    frame.writeUInt32LE(bad.length, 0);
    bad.copy(frame, 4);
    const dec = createFrameDecoder();
    expect(() => dec.feed(frame)).toThrow(/JSON/i);
  });

  it("is poisoned after bad-JSON throw — subsequent feed() throws connection-fatal error", () => {
    const bad = Buffer.from("not-json");
    const frame = Buffer.alloc(4 + bad.length);
    frame.writeUInt32LE(bad.length, 0);
    bad.copy(frame, 4);
    const dec = createFrameDecoder();
    expect(() => dec.feed(frame)).toThrow(/JSON/i);
    // 即使后续 chunk 是合法帧，也必须拒绝——帧流已损坏，禁止捕获后继续 feed
    expect(() => dec.feed(encodeFrame({ type: "ping" }))).toThrow(/已损坏/);
  });

  it("is poisoned after oversized-frame throw too", () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(11 * 1024 * 1024, 0);
    const dec = createFrameDecoder();
    expect(() => dec.feed(buf)).toThrow(/超过/);
    expect(() => dec.feed(encodeFrame({ type: "ping" }))).toThrow(/已损坏/);
  });
});

// ─── parseBridgeMessage ──────────────────────────────────────────────────────

describe("parseBridgeMessage", () => {
  it("accepts a valid ping", () => {
    const msg = parseBridgeMessage({ type: "ping" });
    expect(msg).toEqual({ type: "ping" });
  });

  it("accepts a valid ingest_rows message", () => {
    const raw = { type: "ingest_rows", platform: "douyin", rows: [{ 作品名称: "test" }] };
    const msg = parseBridgeMessage(raw) as Extract<BridgeMessage, { type: "ingest_rows" }>;
    expect(msg.type).toBe("ingest_rows");
    expect(msg.platform).toBe("douyin");
    expect(msg.rows).toHaveLength(1);
  });

  it("rejects unknown type", () => {
    expect(() => parseBridgeMessage({ type: "unknown_cmd" })).toThrow(/未知.*type/);
  });

  it("rejects non-object input", () => {
    expect(() => parseBridgeMessage("hello")).toThrow(/必须是对象/);
  });

  it("rejects null", () => {
    expect(() => parseBridgeMessage(null)).toThrow(/必须是对象/);
  });

  it("rejects ingest_rows missing platform", () => {
    expect(() => parseBridgeMessage({ type: "ingest_rows", rows: [] })).toThrow(/platform/);
  });

  it("rejects ingest_rows where rows is not an array", () => {
    expect(() =>
      parseBridgeMessage({ type: "ingest_rows", platform: "douyin", rows: "bad" }),
    ).toThrow(/rows.*数组/);
  });

  it("rejects ingest_rows where a row entry is not an object", () => {
    expect(() =>
      parseBridgeMessage({ type: "ingest_rows", platform: "douyin", rows: [42] }),
    ).toThrow(/rows\[0\]/);
  });
});
