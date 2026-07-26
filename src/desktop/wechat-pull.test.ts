/**
 * wechat-pull.test.ts — 公众号后台一键拉数 handler:拉取(mock)→ 导入管线 → 报告;
 * 登录态失效给明确扫码指引,不静默。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("./event-hub.js", () => ({ emitEngineEvent: vi.fn(async () => {}) }));

import { wechatPullHandler } from "./wechat-pull.js";
import { saveContent } from "../storage/local-store.js";
import { listOutcomes } from "../modules/flywheel/outcome-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-wxpull-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("flywheel:wechat_pull", () => {
  it("登录态有效 → 行数据进导入管线,标题匹配稿件,返回导入报告", async () => {
    const c = await saveContent(
      { title: "AI 写码的账", body: "b", platform: "wechat_mp", status: "published" as never, tags: [], hashtags: [] },
      dir,
    );
    const pull = vi.fn(async () => ({
      status: "in" as const,
      rows: [{ title: "AI 写码的账", read: 456, share: 12, like: 7, fans: 1200, sentTime: 1783600000 }],
    }));
    const r = (await wechatPullHandler({ _dataDir: dir }, undefined, { pull })) as {
      ok: boolean;
      data: { imported: number; matched: number };
    };
    expect(r.ok).toBe(true);
    expect(r.data.imported).toBe(1);
    expect(r.data.matched).toBe(1);
    const outs = await listOutcomes(dir);
    const o = outs.find((x) => x.contentId === c.id)!;
    expect(o.metrics.views).toBe(456);
    expect(o.metrics.likes).toBe(7);
  });

  it("登录态失效 → needLogin + 扫码指引;瞬时超时 → 提示重试,都不静默", async () => {
    const out = (await wechatPullHandler({ _dataDir: dir }, undefined, {
      pull: vi.fn(async () => ({ status: "out" as const, rows: [] })),
    })) as { ok: boolean; needLogin?: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.needLogin).toBe(true);
    expect(String(out.error)).toContain("扫码");

    const to = (await wechatPullHandler({ _dataDir: dir }, undefined, {
      pull: vi.fn(async () => ({ status: "timeout" as const, rows: [] })),
    })) as { ok: boolean; error?: string };
    expect(to.ok).toBe(false);
    expect(String(to.error)).toContain("重试");
  });
});
