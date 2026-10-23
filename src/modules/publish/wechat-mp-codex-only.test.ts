/** 派生公众号文章配图只走 Codex（Codex 审 2a #4）：链上有中转也不落过去；没配 Codex 就明说失败 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("./wechat-config.js", () => ({ loadWechatMpConfig: vi.fn(async () => cfg.value) }));
vi.mock("./image-gen.js", async (orig) => ({ ...(await orig<typeof import("./image-gen.js")>()), generateImageViaChain: vi.fn() }));

import { generateImageViaChain } from "./image-gen.js";
import { generateWechatImageAsset } from "./wechat-mp.js";

const chainMock = vi.mocked(generateImageViaChain);
beforeEach(() => { chainMock.mockReset(); });

describe("codexOnly", () => {
  it("链是 [codex, 中转]：只把 codex 交给通道链；codex 失败就是失败，不试中转", async () => {
    cfg.value = { imageChain: [{ kind: "codex" }, { kind: "relay", baseUrl: "https://relay.example", apiKey: "k", name: "relay" }] };
    chainMock.mockRejectedValueOnce(new Error("codex: quota exceeded"));
    const r = await generateWechatImageAsset("p", "/tmp/x.png", { codexOnly: true });
    expect(r).toMatchObject({ ok: false, stderr: expect.stringContaining("quota exceeded") });
    expect(chainMock.mock.calls[0][0].map((p) => p.kind)).toEqual(["codex"]);
  });

  it("没配 Codex：不调用任何通道，原因说清", async () => {
    cfg.value = { imageChain: [{ kind: "relay", baseUrl: "https://relay.example", apiKey: "k" }] };
    const r = await generateWechatImageAsset("p", "/tmp/x.png", { codexOnly: true });
    expect(r).toMatchObject({ ok: false, stderr: expect.stringMatching(/没有配 Codex/) });
    expect(chainMock).not.toHaveBeenCalled();
  });
});
