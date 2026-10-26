/**
 * 2026-10-26 安克英文版：04-edit 顶层的「v1-预览」「v2-口型-无字幕」都被对账收成了成片版本。
 * 约定：预览 / 中间片放 04-edit/review/，或文件名带 预览 / preview / 无字幕 / review，对账都不收；真成片照收。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";
import { reconcileContent } from "./reconcile.js";
import { NOT_A_CUT } from "./observe.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

describe("04-edit 里的预览不当成片", () => {
  it("预览 / 无字幕中间片 / review 子目录不收，正常命名的成片照收", async () => {
    const c = await videoContent(env, "预览测试稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "预览测试稿-原片.mov"), "raw"), request_id: "a" });
    const edit = path.join(projectRoot(env, c.id), "04-edit");
    for (const [name, bytes] of [["英文版-v1-预览.mp4", "p1"], ["英文版-v2-口型-无字幕.mp4", "p2"], ["en-v2-preview.mov", "p3"], ["review/英文版-v3-看片.mp4", "p4"], ["英文版-v3-成片.mp4", "real"]]) {
      await put(path.join(edit, name), bytes);
    }
    await reconcileContent(c.id, env.dir);
    const cuts = (await readProductionDoc(c.id, env.dir))!.facts.filter((f) => f.kind === "cut").map((f) => path.basename(f.path ?? ""));
    expect(cuts).toEqual(["英文版-v3-成片.mp4"]);
  });

  it("名字规则", () => {
    for (const n of ["a-预览.mp4", "PREVIEW.mp4", "v2-无字幕.mp4", "review-cut.mp4"]) expect(NOT_A_CUT.test(n)).toBe(true);
    for (const n of ["英文版-v3-成片.mp4", "安克-成片.mp4"]) expect(NOT_A_CUT.test(n)).toBe(false);
  });
});
