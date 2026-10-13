/**
 * 回归（2026-10-13）：NAS 每周完整核对占文件归属锁 22 分钟，content get 排在后面，编辑器一直「正在加载稿件」。
 * 读稿的本条快扫限时：锁忙就照样给稿，带 reconcile_warning。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeContentSave } from "../../tools/content-save.js";
import { withFileOwnership } from "./mutex.js";
import { ensureProductionReady } from "./service.js";
import { makeEnv, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const get = (id: string) => executeContentSave({ action: "get", id, _dataDir: env.dir }) as Promise<Record<string, unknown>>;

describe("content get 不被后台长任务挂死", () => {
  it("锁空闲：快扫照常跑，没有 reconcile_warning", async () => {
    const c = await videoContent(env, "锁空闲的稿");
    const r = await get(c.id);
    expect(r).toMatchObject({ ok: true, content: { id: c.id } });
    expect(r.reconcile_warning).toBeUndefined();
  });

  it("锁被长任务占着：几秒内给稿，并说明这次没核对文件", async () => {
    const c = await videoContent(env, "锁被占着的稿");
    await ensureProductionReady(env.dir);
    let release!: () => void;
    const holder = withFileOwnership(() => new Promise<void>((r) => { release = r; }));
    try {
      const started = Date.now();
      const r = await get(c.id);
      expect(Date.now() - started).toBeLessThan(6000);
      expect(r).toMatchObject({ ok: true, content: { id: c.id } });
      expect(String(r.reconcile_warning)).toContain("后台任务");
    } finally {
      release();
      await holder;
    }
  }, 15_000);

  it("首次就绪也被长任务挡着：同样限时给稿", async () => {
    const c = await videoContent(env, "就绪被挡的稿");
    let release!: () => void;
    const holder = withFileOwnership(() => new Promise<void>((r) => { release = r; }));
    try {
      const r = await get(c.id);
      expect(r).toMatchObject({ ok: true, content: { id: c.id } });
      expect(String(r.reconcile_warning)).toContain("后台任务");
    } finally {
      release();
      await holder;
      await ensureProductionReady(env.dir); // 就绪在后台照常跑完，再清理临时库
    }
  }, 15_000);
});
