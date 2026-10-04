/** 整分支审 8 P2：拖进度（Range）不再每次整份重算 sha；文件身份变了才重算，字节不对照样 409 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

const hashed: string[] = [];
vi.mock("../video/handoff/manifest.js", async (orig) => {
  const m = await orig<typeof import("../video/handoff/manifest.js")>();
  return { ...m, sha256File: async (f: string) => { hashed.push(f); return m.sha256File(f); } };
});

const { openAttachment, openFactMedia } = await import("./inbox-attachment.js");
const { founderApprove, makeEnv, projectRoot, put, record, videoContent } = await import("./testkit.js");
const { executeContentSave } = await import("../../tools/content-save.js");
type Env = Awaited<ReturnType<typeof makeEnv>>;

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

describe("预览 / 附件的字节核对按文件身份缓存", () => {
  it("成片预览：同一文件两次只算一次；文件换了再算，字节不对回 409", async () => {
    const c = await videoContent(env, "缓存测试稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "缓存测试稿-原片.mov"), "raw"), request_id: "a" });
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "缓存测试稿.mp4"), "cut-bytes"), request_id: "c" });
    const file = path.join(projectRoot(env, c.id), String(cut.path));
    const count = () => hashed.filter((h) => h.endsWith(path.basename(file))).length;
    expect((await openFactMedia(c.id, String(cut.fact_id), env.dir)).ok).toBe(true);
    const n1 = count();
    expect((await openFactMedia(c.id, String(cut.fact_id), env.dir)).ok).toBe(true);
    expect(count()).toBe(n1);
    await put(file, "different-and-longer-bytes");
    expect(await openFactMedia(c.id, String(cut.fact_id), env.dir)).toMatchObject({ ok: false, status: 409 });
    expect(count()).toBe(n1 + 1);
  });

  it("请示附件同样只算一次", async () => {
    const c = await videoContent(env, "附件缓存稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "附件缓存稿-原片.mov"), "raw"), request_id: "a" });
    const vid = await put(path.join(projectRoot(env, c.id), "04-edit/样片.mp4"), "sample");
    const q = await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: "codex", action: "ask", content_id: c.id, request_id: "q", kind: "样片", question: "看看", options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }], attachments: [vid] }) as Record<string, unknown>;
    const before = hashed.filter((h) => h.endsWith("样片.mp4")).length;
    await openAttachment(c.id, String(q.ask_id), 0, env.dir);
    await openAttachment(c.id, String(q.ask_id), 0, env.dir);
    expect(hashed.filter((h) => h.endsWith("样片.mp4")).length - before).toBeLessThanOrEqual(1);
  });
});
