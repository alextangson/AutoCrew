/**
 * 整分支审 13：归档的稿不进「等你拍板」，请示 / 标可以审 / 报文件都要当场拒，不能「成功」了却没人看得见。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { executeContentSave } from "../../tools/content-save.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { founderApprove, makeEnv, put, record, setContent, videoContent, type Env } from "./testkit.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });
const agent = (p: Record<string, unknown>) => executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: "codex", ...p }) as Promise<Record<string, unknown>>;

describe("归档的稿", () => {
  it("ask / mark_ready / record 都拒，什么都不记", async () => {
    const c = await videoContent(env, "归档后请示");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "归档后请示-原片.mov"), "raw"), request_id: "a" });
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "归档后请示.mp4"), "cut"), request_id: "c" });
    await setContent(env, c.id, { status: "archived" });
    expect(await agent({ action: "ask", content_id: c.id, request_id: "q", kind: "粗剪", question: "行吗", options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }] }))
      .toMatchObject({ ok: false, error: "这条稿已经归档了，请示发不出去" });
    expect(await agent({ action: "mark_ready", content_id: c.id, fact_id: cut.fact_id })).toMatchObject({ ok: false, code: "archived" });
    expect(await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "归档后请示-2.mp4"), "cut-2"), request_id: "c2" })).toMatchObject({ ok: false, code: "archived" });
    const d = (await readProductionDoc(c.id, env.dir))!;
    expect(d.asks ?? []).toEqual([]);
    expect(d.ready_marks ?? []).toEqual([]);
    expect(d.facts.filter((f) => f.kind === "cut")).toHaveLength(1);
  });
});
