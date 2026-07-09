/**
 * cover-handlers.test.ts — 桌面封面频道:key 解析/掩码、后台化 runId、事件透出。
 * executeCoverReview 与 event-hub 全 mock。
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
  it("写入 key+model → 读回掩码,原文不回显,source=file", async () => {
    const w = await coverSettingsSetHandler({ gemini_api_key: "AIzaSyTest12345678", gemini_model: "gemini-native", _dataDir: dir });
    expect(w.ok).toBe(true);
    const r = (await coverSettingsGetHandler({ _dataDir: dir })) as { ok: boolean; data: { configured: boolean; apiKeyMasked: string; source: string; model: string } };
    expect(r.data.configured).toBe(true);
    expect(r.data.apiKeyMasked).toBe("AIza…5678");
    expect(r.data.apiKeyMasked).not.toContain("SyTest");
    expect(r.data.source).toBe("file");
    expect(r.data.model).toBe("gemini-native");
    // 文件 0600
    const stat = await fs.stat(path.join(dir, "cover.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("非法模型 → 拒;空更新 → 拒", async () => {
    const bad = await coverSettingsSetHandler({ gemini_model: "dall-e", _dataDir: dir });
    expect(bad.ok).toBe(false);
    const empty = await coverSettingsSetHandler({ _dataDir: dir });
    expect(empty.ok).toBe(false);
  });

  it("无 key → configured:false source:none", async () => {
    const r = (await coverSettingsGetHandler({ _dataDir: dir })) as { data: { configured: boolean; source: string } };
    expect(r.data.configured).toBe(false);
    expect(r.data.source).toBe("none");
  });
});

describe("startCoverJob(后台化)", () => {
  it("未配置 key → 即时报错带 hint,不发事件", async () => {
    const job = await startCoverJob({ content_id: "content-1-a", _dataDir: dir }, "create_candidates", { work: "w", done: "d" });
    expect(job.response.ok).toBe(false);
    expect(String(job.response.hint)).toContain("aistudio");
    await job.completion;
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("有 key → pending+runId 即返,后台注入 _geminiApiKey,完成发 run_done", async () => {
    await coverSettingsSetHandler({ gemini_api_key: "AIzaSyTest12345678", _dataDir: dir });
    execMock.mockResolvedValueOnce({ ok: true } as never);
    const job = await startCoverJob({ content_id: "content-1-a", _dataDir: dir }, "create_candidates", { work: "开工", done: "完工" });
    expect(job.response).toMatchObject({ ok: true, pending: true });
    expect(String(job.response.runId)).toMatch(/^run-cover-/);
    await job.completion;
    expect(execMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_candidates", _geminiApiKey: "AIzaSyTest12345678", _dataDir: dir }),
    );
    const kinds = emitMock.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toEqual(["work", "run_done"]);
  });

  it("后台失败 → run_failed 带原因(不 throw 给调用方)", async () => {
    await coverSettingsSetHandler({ gemini_api_key: "AIzaSyTest12345678", _dataDir: dir });
    execMock.mockResolvedValueOnce({ ok: false, error: "quota exceeded" } as never);
    const job = await startCoverJob({ content_id: "content-1-a", _dataDir: dir }, "revise", { work: "w", done: "d" });
    await job.completion;
    const last = emitMock.mock.calls.at(-1)![0] as { kind: string; label: string };
    expect(last.kind).toBe("run_failed");
    expect(last.label).toContain("quota");
  });

  it("coverCreateHandler 只透出 response(无 completion 泄漏)", async () => {
    await coverSettingsSetHandler({ gemini_api_key: "AIzaSyTest12345678", _dataDir: dir });
    execMock.mockResolvedValueOnce({ ok: true } as never);
    const r = await coverCreateHandler({ content_id: "content-1-a", _dataDir: dir });
    expect(r.pending).toBe(true);
    expect("completion" in r).toBe(false);
  });
});

describe("coverGetHandler", () => {
  it("注入 action=get 转发", async () => {
    execMock.mockResolvedValueOnce({ ok: true, review: { status: "review_pending" } } as never);
    const r = await coverGetHandler({ content_id: "content-1-a", _dataDir: dir });
    expect(r.ok).toBe(true);
    expect(execMock).toHaveBeenCalledWith(expect.objectContaining({ action: "get", content_id: "content-1-a" }));
  });
});
