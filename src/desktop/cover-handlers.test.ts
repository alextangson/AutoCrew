/**
 * cover-handlers.test.ts — 桌面封面频道:provider 解析/掩码、后台化 runId、事件透出。
 * executeCoverReview 与 event-hub 全 mock。V5.6.1:默认 provider=relay(中转)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../tools/cover-review.js", () => ({ executeCoverReview: vi.fn() }));
vi.mock("./event-hub.js", () => ({ emitEngineEvent: vi.fn(async () => {}) }));

import { executeCoverReview } from "../tools/cover-review.js";
import { emitEngineEvent } from "./event-hub.js";
import {
  startCoverJob,
  coverCreateHandler,
  coverGetHandler,
  coverSettingsGetHandler,
  coverSettingsSetHandler,
} from "./cover-handlers.js";

const execMock = vi.mocked(executeCoverReview);
const emitMock = vi.mocked(emitEngineEvent);

let dir: string;
let savedEnvKey: string | undefined;

async function seedRelay(): Promise<void> {
  await fs.writeFile(
    path.join(dir, "publish.json"),
    JSON.stringify({ wechatMp: { imageApiKey: "sk-relay-123456", imageBaseUrl: "https://relay.test/v1", imageModel: "gpt-image-2" } }),
    "utf-8",
  );
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-coverhandlers-"));
  execMock.mockReset();
  emitMock.mockClear();
  savedEnvKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  if (savedEnvKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedEnvKey;
});

describe("settings:cover_*", () => {
  it("默认 provider=relay;写 gemini key/model → 读回掩码,原文不回显", async () => {
    const w = await coverSettingsSetHandler({ gemini_api_key: "AIzaSyTest12345678", gemini_model: "gemini-native", _dataDir: dir });
    expect(w.ok).toBe(true);
    const r = (await coverSettingsGetHandler({ _dataDir: dir })) as {
      ok: boolean;
      data: { provider: string; relay: { configured: boolean }; gemini: { configured: boolean; apiKeyMasked: string; source: string; model: string } };
    };
    expect(r.data.provider).toBe("relay");
    expect(r.data.relay.configured).toBe(false);
    expect(r.data.gemini.configured).toBe(true);
    expect(r.data.gemini.apiKeyMasked).toBe("AIza…5678");
    expect(r.data.gemini.apiKeyMasked).not.toContain("SyTest");
    expect(r.data.gemini.source).toBe("file");
    expect(r.data.gemini.model).toBe("gemini-native");
    const stat = await fs.stat(path.join(dir, "cover.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("provider 切换 + 中转模型覆盖生效;publish.json 配好后 relay.configured", async () => {
    await seedRelay();
    await coverSettingsSetHandler({ provider: "relay", relay_model: "gpt-image-2-hd", _dataDir: dir });
    const r = (await coverSettingsGetHandler({ _dataDir: dir })) as { data: { provider: string; relay: { configured: boolean; model: string } } };
    expect(r.data.provider).toBe("relay");
    expect(r.data.relay.configured).toBe(true);
    expect(r.data.relay.model).toBe("gpt-image-2-hd");
  });

  it("非法 provider/模型 → 拒;空更新 → 拒", async () => {
    expect((await coverSettingsSetHandler({ provider: "midjourney", _dataDir: dir })).ok).toBe(false);
    expect((await coverSettingsSetHandler({ gemini_model: "dall-e", _dataDir: dir })).ok).toBe(false);
    expect((await coverSettingsSetHandler({ _dataDir: dir })).ok).toBe(false);
  });
});

describe("startCoverJob(后台化)", () => {
  it("relay 未配置(默认 provider) → 即时报错指向 设置·发布,不发事件", async () => {
    const job = await startCoverJob({ content_id: "content-1-a", _dataDir: dir }, "create_candidates", { work: "w", done: "d" });
    expect(job.response.ok).toBe(false);
    expect(String(job.response.error)).toContain("中转");
    expect(String(job.response.hint)).toContain("设置·发布");
    await job.completion;
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("relay 配好 → pending+runId,不注入 gemini 参数,完成发 run_done", async () => {
    await seedRelay();
    execMock.mockResolvedValueOnce({ ok: true } as never);
    const job = await startCoverJob({ content_id: "content-1-a", _dataDir: dir }, "create_candidates", { work: "开工", done: "完工" });
    expect(job.response).toMatchObject({ ok: true, pending: true });
    expect(String(job.response.runId)).toMatch(/^run-cover-/);
    await job.completion;
    const call = execMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.action).toBe("create_candidates");
    expect(call._dataDir).toBe(dir);
    expect("_geminiApiKey" in call).toBe(false);
    const kinds = emitMock.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toEqual(["work", "run_done"]);
  });

  it("provider=gemini → 注入 _geminiApiKey/_geminiModel", async () => {
    await coverSettingsSetHandler({ provider: "gemini", gemini_api_key: "AIzaSyTest12345678", _dataDir: dir });
    execMock.mockResolvedValueOnce({ ok: true } as never);
    const job = await startCoverJob({ content_id: "content-1-a", _dataDir: dir }, "create_candidates", { work: "w", done: "d" });
    await job.completion;
    expect(execMock).toHaveBeenCalledWith(
      expect.objectContaining({ _geminiApiKey: "AIzaSyTest12345678", _geminiModel: "auto" }),
    );
  });

  it("后台失败 → run_failed 带原因;结果 warnings 拼进 run_done", async () => {
    await seedRelay();
    execMock.mockResolvedValueOnce({ ok: false, error: "quota exceeded" } as never);
    const failJob = await startCoverJob({ content_id: "content-1-a", _dataDir: dir }, "revise", { work: "w", done: "d" });
    await failJob.completion;
    const last = emitMock.mock.calls.at(-1)![0] as { kind: string; label: string };
    expect(last.kind).toBe("run_failed");
    expect(last.label).toContain("quota");

    emitMock.mockClear();
    execMock.mockResolvedValueOnce({ ok: true, warnings: ["A: 中转不支持参考图(/images/edits),本次未带人物形象"] } as never);
    const warnJob = await startCoverJob({ content_id: "content-1-a", _dataDir: dir }, "create_candidates", { work: "w", done: "完工" });
    await warnJob.completion;
    const done = emitMock.mock.calls.at(-1)![0] as { kind: string; label: string };
    expect(done.kind).toBe("run_done");
    expect(done.label).toContain("未带人物");
  });

  it("coverCreateHandler 只透出 response(无 completion 泄漏)", async () => {
    await seedRelay();
    execMock.mockResolvedValueOnce({ ok: true } as never);
    const r = await coverCreateHandler({ content_id: "content-1-a", _dataDir: dir });
    expect(r.pending).toBe(true);
    expect("completion" in r).toBe(false);
  });
});

describe("coverGetHandler", () => {
  it("注入 action=get 转发(不需要 provider 可用)", async () => {
    execMock.mockResolvedValueOnce({ ok: true, review: { status: "review_pending" } } as never);
    const r = await coverGetHandler({ content_id: "content-1-a", _dataDir: dir });
    expect(r.ok).toBe(true);
    expect(execMock).toHaveBeenCalledWith(expect.objectContaining({ action: "get", content_id: "content-1-a" }));
  });
});
