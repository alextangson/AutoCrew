import { describe, it, expect, vi, beforeEach } from "vitest";
import { DoubaoTTS } from "./doubao.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

describe("DoubaoTTS", () => {
  let tts: DoubaoTTS;

  beforeEach(() => {
    tts = new DoubaoTTS({
      appId: "test-app",
      accessToken: "test-token",
      voiceType: "BV700_V2_streaming",
    });
    vi.clearAllMocks();
  });

  it("has correct name", () => {
    expect(tts.name).toBe("doubao");
  });

  it("estimates duration for Chinese text", () => {
    const duration = tts.estimateDuration("今天我们来聊聊效率工具"); // 10 chars
    expect(duration).toBeCloseTo(2.5, 0);
  });

  it("generates audio from text", async () => {
    const fakeBase64 = Buffer.from("fake-audio-data").toString("base64");
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 3000, message: "Success", data: fakeBase64 }),
    });

    const result = await tts.generate("你好世界", {
      voiceId: "BV700_V2_streaming",
    }, "/tmp/output.mp3");

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.format).toBe("mp3");

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.app.appid).toBe("test-app");
    expect(callBody.request.text).toBe("你好世界");
  });

  it("sends correct authorization header", async () => {
    const fakeBase64 = Buffer.from("data").toString("base64");
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 3000, message: "Success", data: fakeBase64 }),
    });

    await tts.generate("测试", { voiceId: "BV700_V2_streaming" }, "/tmp/out.mp3");

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer;test-token");
  });

  it("throws on API error", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 4000, message: "Invalid token" }),
    });

    await expect(
      tts.generate("你好", { voiceId: "BV700_V2_streaming" }, "/tmp/out.mp3")
    ).rejects.toThrow("Doubao TTS error 4000: Invalid token");
  });

  it("lists voices", async () => {
    const voices = await tts.listVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]).toHaveProperty("id");
    expect(voices[0]).toHaveProperty("language", "zh-CN");
  });
});
