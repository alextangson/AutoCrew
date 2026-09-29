/**
 * Segment ① Codex 评审（~/.cache/autocrew-yt/ontology-advisor/codex-review-seg1.txt）的回归测试——
 * 其余几条在 record / reconcile / derive 测试里，标题带 [Codex …]。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, updateContent } from "../../storage/local-store.js";
import { isOntologyEnabled, readEnabledMarker, readProductionDoc, ScriptFrozenError, writeEnabledVersion } from "../../storage/production-store.js";
import { parsePublishPlan } from "../../storage/publish-record.js";
import { executePublish } from "../../tools/publish.js";
import { boardData } from "../../desktop/board-data.js";
import { publishEvidenceFrom } from "./read.js";
import { enableOntology } from "./enable.js";
import { reopenScript } from "./reopen.js";
import { reconcileAll } from "./reconcile.js";
import { productionServiceDir } from "../../storage/production-store.js";
import { exists, founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

const TITLE = "AI 又忘了怎么办";
const plan = (status: string, extra: Record<string, unknown> = {}) => parsePublishPlan(JSON.stringify({ platforms: [{ platform: "douyin", publication: { status, ...extra } }] }));

describe("[Codex P1 read.ts:18] 被驳回的回执不命中 D1（用真实发布记录解析器）", () => {
  it("rejected → 不算已投出；public → 算", () => {
    expect(publishEvidenceFrom(plan("rejected")).verified).toBe(false);
    expect(publishEvidenceFrom(plan("public")).verified).toBe(true);
  });
});

describe("[Codex P2 read.ts:28] 外部发布证据绑定到制作轮次", () => {
  it("本轮开始之前的发布证据不算本轮 D1", () => {
    const old = plan("public", { published_at: "2026-09-01T00:00:00Z" });
    expect(publishEvidenceFrom(old, "2026-09-20T00:00:00Z").verified).toBe(false);
    expect(publishEvidenceFrom(old).verified).toBe(true);
  });
});

describe("[Codex P1 production-hooks.ts:66] content-save 之外的模型入口也推不过认稿", () => {
  it("模型调 autocrew_publish confirm_published：拒，状态不动", async () => {
    const c = await videoContent(env, TITLE);
    const r = await executePublish({ _dataDir: env.dir, _host: "claude-code", action: "confirm_published", content_id: c.id });
    expect(r).toMatchObject({ ok: false });
    expect((await getContent(c.id, env.dir))!.status).toBe("draft_ready");
  });
});

describe("[Codex P1 production-hooks.ts:84] 认稿落盘时同步投影与冻结", () => {
  it("写稿段已有原片，创始人认稿 → 立即剪辑中、冻结，之后改正文被拒", async () => {
    await writeEnabledVersion(env.dir);
    const c = await videoContent(env, TITLE);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "r1" });
    await founderApprove(env, c.id);
    expect((await getContent(c.id, env.dir))!.status).toBe("editing");
    expect((await readProductionDoc(c.id, env.dir))!.frozen).toMatchObject({ round: 1 });
    await expect(updateContent(c.id, { body: "改" }, env.dir)).rejects.toBeInstanceOf(ScriptFrozenError);
  });
});

describe("[Codex P1 reopen.ts:64] 重开已提交后派生写入失败：不撤回已提交的重开", () => {
  it("时间线写失败：round 仍是 2、原片留在 _作废-1、日志清掉", async () => {
    await writeEnabledVersion(env.dir);
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "r1" });
    const store = await import("../../storage/production-store.js");
    vi.spyOn(store, "appendTimeline").mockRejectedValueOnce(new Error("时间线写不进去"));
    expect(await reopenScript(c.id, env.dir)).toMatchObject({ ok: true, round: 2 });
    expect((await readProductionDoc(c.id, env.dir))!.round).toBe(2);
    expect(await exists(path.join(projectRoot(env, c.id), "02-aroll/_作废-1/AI 又忘了怎么办-原片.mov"))).toBe(true);
    expect(await fs.readdir(productionServiceDir(env.dir, "txns")).catch(() => [])).toEqual([]);
  });
});

describe("[Codex P1 enable.ts:45] 启用是可恢复事务：保护措施没完成就不打开开关；坏条目可明确排除", () => {
  it("一条冻结写不进去 → 不启用、列出这条；创始人排除它后启用，它留在旧行为并标出来", async () => {
    const bad = await videoContent(env, TITLE, "approved");
    const good = await videoContent(env, "另一条好好的稿", "approved");
    await put(path.join(projectRoot(env, bad.id), "02-aroll/raw.mov"), "raw-bad");
    await put(path.join(projectRoot(env, good.id), "02-aroll/raw.mov"), "raw-good");
    // 冻结副本要写进 01-script/frozen/：把它占成文件，冻结必然失败
    await fs.mkdir(path.join(projectRoot(env, bad.id), "01-script"), { recursive: true });
    await fs.writeFile(path.join(projectRoot(env, bad.id), "01-script/frozen"), "not a dir");
    const first = await enableOntology(env.dir);
    expect(first).toMatchObject({ ok: false });
    expect(first.failures).toEqual([expect.objectContaining({ id: bad.id, step: "投影" })]);
    expect(await isOntologyEnabled(env.dir)).toBe(false);
    const second = await enableOntology(env.dir, { exclude: [bad.id] });
    expect(second).toMatchObject({ ok: true, excluded: [bad.id] });
    expect((await readEnabledMarker(env.dir))!.excluded).toEqual([bad.id]);
    expect((await getContent(good.id, env.dir))!.status).toBe("editing");
    const item = (await boardData(env.dir)).items.find((i) => i.id === bad.id)!;
    expect(item.badges.join("")).toContain("未纳入本体");
    expect(await record(env, { content_id: bad.id, kind: "cut", path: await put(path.join(env.chatcut, "x.mp4"), "c"), request_id: "r" })).toMatchObject({ code: "ontology_not_enabled" });
  });
});

describe("哈希缓存落盘：重启不必重算每个 A-roll", () => {
  it("对账后缓存文件记着项目里的文件", async () => {
    const c = await videoContent(env, TITLE, "approved");
    const raw = await put(path.join(projectRoot(env, c.id), "02-aroll/raw.mov"), "raw");
    await reconcileAll(env.dir);
    const cache = JSON.parse(await fs.readFile(productionServiceDir(env.dir, "hash-cache.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(cache)).toContain(await fs.realpath(raw));
  });
});
