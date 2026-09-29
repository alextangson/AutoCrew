/**
 * 认稿硬门（§2.1）、认稿去留（§13-C / E34）、冻结（§2.5 / E18）、重开文稿（§2.5 / E27）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getContent, listVersions, revertToVersion, updateContent, updateContentChecked, updateContentIfDraftMatches,
} from "../../storage/local-store.js";
import { bodyHash, readProductionDoc, ScriptFrozenError, scriptApprovalFor, writeEnabledVersion } from "../../storage/production-store.js";
import { executeContentSave } from "../../tools/content-save.js";
import { executeReview } from "../../tools/review.js";
import { executeAsset } from "../../tools/asset.js";
import { reopenScript } from "./reopen.js";
import { recoverTxns } from "./txn.js";
import { exists, founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv(); });
afterEach(async () => { await env.cleanup(); });

const TITLE = "AI 又忘了怎么办";
const MODEL = { _host: "claude-code" };
/** 本机的 MCP 宿主（同样是模型调用；和工作台共用 local-user 认领，不撞 claim_held） */
const LOCAL_MODEL = { _host: "local-user" };

describe("认稿硬门：模型经 save / update / transition / force 推到认稿及之后全拒", () => {
  it.each(["approved", "editing", "cover_pending", "publish_ready", "publishing", "published"])("transition → %s（带 force）", async (target) => {
    const c = await videoContent(env, TITLE);
    const r = await executeContentSave({ _dataDir: env.dir, ...MODEL, action: "transition", id: c.id, target_status: target, force: true });
    expect(r).toMatchObject({ ok: false });
    expect((await getContent(c.id, env.dir))!.status).toBe("draft_ready");
    expect(await readProductionDoc(c.id, env.dir)).toBeNull();
  });

  it("transition → approved 的拒绝码是 founder_decision_required", async () => {
    const c = await videoContent(env, TITLE);
    expect(await executeContentSave({ _dataDir: env.dir, ...MODEL, action: "transition", id: c.id, target_status: "approved", force: true }))
      .toMatchObject({ ok: false, code: "founder_decision_required" });
  });

  it("update{status: approved} 拒、正文也不落", async () => {
    // reviewing → approved 在状态图上是合法边，拦它的只能是认稿硬门
    const c = await videoContent(env, TITLE, "reviewing");
    const r = await executeContentSave({ _dataDir: env.dir, ...MODEL, action: "update", id: c.id, body: "偷改", status: "approved" });
    expect(r).toMatchObject({ ok: false, code: "founder_decision_required" });
    expect(await executeContentSave({ _dataDir: env.dir, ...MODEL, action: "transition", id: c.id, target_status: "approved" })).toMatchObject({ ok: false, code: "founder_decision_required" });
    expect((await getContent(c.id, env.dir))!.body).not.toBe("偷改");
  });

  it("save{status: approved}（模型导入）只能落在 draft_ready", async () => {
    const r = await executeContentSave({ _dataDir: env.dir, ...MODEL, action: "save", title: "导入", body: "正文", platform: "douyin", status: "approved", source: "manual_import", import_reason: "创作者给的成稿" });
    expect(r).toMatchObject({ ok: true, content: { status: "draft_ready" } });
  });

  it("OpenClaw 模型调用（_modelCall）同样拒", async () => {
    const c = await videoContent(env, TITLE);
    expect(await executeContentSave({ _dataDir: env.dir, _modelCall: true, action: "transition", id: c.id, target_status: "approved", force: true })).toMatchObject({ ok: false });
  });

  it("创始人认稿写认稿决定，绑正文哈希", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    const doc = (await readProductionDoc(c.id, env.dir))!;
    expect(doc.decisions).toMatchObject([{ type: "script_approval", source: "founder", body_hash: bodyHash(c.body) }]);
  });
});

describe("待录制改稿：创始人改重绑、agent 改作废（§13-C，E34）", () => {
  it("创始人（工作台）改正文 → 认稿重绑新正文，仍在待录制", async () => {
    await writeEnabledVersion(env.dir);
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    expect(await executeContentSave({ _dataDir: env.dir, action: "update", id: c.id, body: "创始人改了一句" })).toMatchObject({ ok: true });
    const doc = (await readProductionDoc(c.id, env.dir))!;
    expect(scriptApprovalFor(doc, "创始人改了一句")).toMatchObject({ source: "founder" });
    expect((await getContent(c.id, env.dir))!.status).toBe("approved");
  });

  it("agent 改正文 → 认稿失效，回写稿中「等你认稿」", async () => {
    await writeEnabledVersion(env.dir);
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    expect(await executeContentSave({ _dataDir: env.dir, ...LOCAL_MODEL, action: "update", id: c.id, body: "AI 改了一句" })).toMatchObject({ ok: true });
    const doc = (await readProductionDoc(c.id, env.dir))!;
    expect(scriptApprovalFor(doc, "AI 改了一句")).toBeNull();
    expect((await getContent(c.id, env.dir))!.status).toBe("draft_ready");
  });

  it("只改标题不动认稿", async () => {
    await writeEnabledVersion(env.dir);
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    await executeContentSave({ _dataDir: env.dir, ...LOCAL_MODEL, action: "update", id: c.id, title: "换个标题" });
    expect((await getContent(c.id, env.dir))!.status).toBe("approved");
    expect(scriptApprovalFor((await readProductionDoc(c.id, env.dir))!, c.body)).not.toBeNull();
  });
});

async function frozenContent(body?: string) {
  await writeEnabledVersion(env.dir);
  const c = await videoContent(env, TITLE, "draft_ready", body);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "r1" });
  return c;
}

describe("冻结：进剪辑中后所有写正文的口都拒（§2.5，E18）", () => {
  it("进剪辑中写冻结副本 01-script/frozen/<正文哈希>.md", async () => {
    const c = await frozenContent();
    const doc = (await readProductionDoc(c.id, env.dir))!;
    expect(doc.frozen?.path).toBe(`01-script/frozen/${bodyHash(c.body)}.md`);
    expect(await fs.readFile(path.join(projectRoot(env, c.id), doc.frozen!.path), "utf8")).toBe(c.body);
  });

  it("content update（MCP 与工作台）", async () => {
    const c = await frozenContent();
    expect(await executeContentSave({ _dataDir: env.dir, ...LOCAL_MODEL, action: "update", id: c.id, body: "改" })).toMatchObject({ ok: false, code: "script_frozen" });
    expect(await executeContentSave({ _dataDir: env.dir, action: "update", id: c.id, body: "改" })).toMatchObject({ ok: false, code: "script_frozen" });
  });

  it("存储写口：updateContent / updateContentChecked / updateContentIfDraftMatches（writer submit、我的内容回写走这几条）", async () => {
    const c = await frozenContent();
    await expect(updateContent(c.id, { body: "改" }, env.dir)).rejects.toBeInstanceOf(ScriptFrozenError);
    await expect(updateContent(c.id, { body: "改", _editor: "founder" }, env.dir)).rejects.toBeInstanceOf(ScriptFrozenError);
    await expect(updateContentChecked(c.id, { body: "改" }, async () => null, env.dir)).rejects.toBeInstanceOf(ScriptFrozenError);
    await expect(updateContentIfDraftMatches(c.id, c, { body: "改" }, env.dir)).rejects.toBeInstanceOf(ScriptFrozenError);
    expect((await getContent(c.id, env.dir))!.body).toBe(c.body);
  });

  it("asset 版本回滚（asset.ts revert）", async () => {
    const c = await videoContent(env, TITLE);
    await updateContent(c.id, { body: "第二版" }, env.dir);
    await writeEnabledVersion(env.dir);
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "r1" });
    const v1 = (await listVersions(c.id, env.dir))[0].version;
    await expect(revertToVersion(c.id, v1, env.dir)).rejects.toBeInstanceOf(ScriptFrozenError);
    await expect(executeAsset({ _dataDir: env.dir, action: "revert", content_id: c.id, version: v1 })).rejects.toBeInstanceOf(ScriptFrozenError);
  });

  it("review auto_fix（正文行尾有空白，auto_fix 会想写回）", async () => {
    const c = await frozenContent("定稿正文，行尾有空白。   ");
    await expect(executeReview({ _dataDir: env.dir, action: "auto_fix", content_id: c.id, platform: "douyin" })).rejects.toBeInstanceOf(ScriptFrozenError);
    expect((await getContent(c.id, env.dir))!.body).toBe(c.body);
  });

  it("只改标题、挂素材这类不动正文的写照常", async () => {
    const c = await frozenContent();
    expect(await updateContent(c.id, { title: "新标题" }, env.dir)).toMatchObject({ title: "新标题" });
  });
});

describe("重开文稿（§2.5，E27）", () => {
  it("结束本轮：原片挪进 02-aroll/_作废-1/，round+1、解冻、回写稿中；改稿又能写", async () => {
    const c = await frozenContent();
    const r = await reopenScript(c.id, env.dir);
    expect(r).toMatchObject({ ok: true, round: 2, moved: ["02-aroll/_作废-1/AI 又忘了怎么办-原片.mov"] });
    expect(await exists(path.join(projectRoot(env, c.id), "02-aroll/_作废-1/AI 又忘了怎么办-原片.mov"))).toBe(true);
    const doc = (await readProductionDoc(c.id, env.dir))!;
    expect(doc).toMatchObject({ round: 2, frozen: null });
    expect(doc.facts[0]).toMatchObject({ round: 1, path: "02-aroll/_作废-1/AI 又忘了怎么办-原片.mov" });
    expect((await getContent(c.id, env.dir))!.status).toBe("draft_ready");
    expect(await updateContent(c.id, { body: "重写" }, env.dir)).toMatchObject({ body: "重写" });
  });

  it("被 ChatCut 工程引用的原片重开时也不挪（E26）", async () => {
    const c = await frozenContent();
    const aroll = (await readProductionDoc(c.id, env.dir))!.facts[0];
    await record(env, { content_id: c.id, kind: "chatcut_project", chatcut_project_id: "p1", uses_aroll: [aroll.id], request_id: "r2" });
    expect(await reopenScript(c.id, env.dir)).toMatchObject({ ok: true, moved: [] });
    expect(await exists(path.join(projectRoot(env, c.id), aroll.path!))).toBe(true);
  });

  it("挪到一半进程没了：启动恢复按事务 id 判未提交，把原片挪回", async () => {
    const c = await frozenContent();
    const root = projectRoot(env, c.id);
    const { saveTxn } = await import("./txn.js");
    // 模拟：日志已落、文件已挪、production.json 还没记事务 id
    const src = path.join(root, "02-aroll/AI 又忘了怎么办-原片.mov");
    const dst = path.join(root, "02-aroll/_作废-1/AI 又忘了怎么办-原片.mov");
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    const sha = (await readProductionDoc(c.id, env.dir))!.facts[0].sha256!;
    await saveTxn(env.dir, { id: "txn-crash-1", kind: "reopen", content_id: c.id, round: 1, at: new Date().toISOString(), ops: [{ op: "move", source: src, target: dst, sha256: sha, step: "placed" }] });
    expect(await recoverTxns(env.dir)).toEqual([{ id: "txn-crash-1", content_id: c.id, outcome: "rolled_back" }]);
    expect(await exists(src)).toBe(true);
    expect(await exists(dst)).toBe(false);
  });
});
