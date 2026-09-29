/** autocrew_content summary（spec v1.3 §1，边界 M3–M6） */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimContent } from "../storage/claims.js";
import { saveContent, softDeleteContent, updateContent } from "../storage/local-store.js";
import { executeContentSave } from "./content-save.js";
import { hostPolicy } from "../../mcp/host-policy.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "summary-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const summary = (id: string) => executeContentSave({ action: "summary", id, _dataDir: dir }) as Promise<Record<string, unknown>>;

describe("autocrew_content summary", () => {
  it("只回进度：标题、平台、中文阶段、卡在哪、下一步、更新时间、字数；不带正文；≤1.5KB", async () => {
    const c = await saveContent({ title: "FDE 会消失", body: "正文".repeat(4000), platform: "douyin" } as never, dir);
    await updateContent(c.id, { status: "needs_evidence", blockedReason: "有 3 个数字缺来源", unverifiedNumbers: ["1", "2", "3"] } as never, dir);
    const r = await summary(c.id);
    expect(r).toMatchObject({ ok: true, title: "FDE 会消失", platform: "douyin", status: "needs_evidence", stage: "缺证据", words: 8000 });
    expect((r.blockers as string[])[0]).toContain("证据门没过");
    expect(String(r.next)).toContain("find_evidence");
    expect(JSON.stringify(r)).not.toContain("正文正文");
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(1536);
  });
  it("M3：不存在 / 已删除 → 明确报找不到，不回空对象", async () => {
    expect(await summary("content-1-nope")).toMatchObject({ ok: false, code: "not_found" });
    const c = await saveContent({ title: "t", body: "b", platform: "douyin" } as never, dir);
    await softDeleteContent(c.id, dir);
    expect(await summary(c.id)).toMatchObject({ ok: false, error: expect.stringContaining("找不到这篇稿") });
  });
  it("M4：被别的会话认领 → 写明谁、多久前；绝不带令牌", async () => {
    const c = await saveContent({ title: "t", body: "b", platform: "douyin" } as never, dir);
    const claimed = await claimContent(c.id, "writer", "claude-code", dir);
    const token = claimed.ok ? claimed.claim.token : "";
    const r = await summary(c.id);
    expect((r.blockers as string[]).join()).toMatch(/被 claude-code（写手）认领，\d+ 分钟前/);
    expect(JSON.stringify(r)).not.toContain(token);
  });
  it("M5：没进写作流程的稿（手写导入）→ 状态照实写，卡在哪写「没有进行中的流程」", async () => {
    const c = await saveContent({ title: "导入稿", body: "手写的", platform: "wechat_mp" } as never, dir);
    const r = await summary(c.id);
    expect(r.blockers).toEqual(["没有进行中的流程"]);
    expect(typeof r.stage).toBe("string");
  });
  it("M6：需要正文时 get 照旧返回完整内容", async () => {
    const c = await saveContent({ title: "t", body: "完整正文在这里", platform: "douyin" } as never, dir);
    const r = await executeContentSave({ action: "get", id: c.id, _dataDir: dir }) as { content: { body: string } };
    expect(r.content.body).toBe("完整正文在这里");
  });
  it("只读动作：受限宿主（codex 剪辑工位）也能调", () => {
    expect(hostPolicy("codex", "autocrew_content", { action: "summary" })).toEqual({ ok: true });
    expect(hostPolicy("workbuddy", "autocrew_content", { action: "summary" })).toEqual({ ok: true });
  });
});
