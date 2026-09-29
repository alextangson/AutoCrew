/** 创始人看真看板提的界面问题（Part F）：平台中文名、人话原因、选择文件、未登记就发布、发布计划的说法 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type http from "node:http";
import path from "node:path";
import { createBoardHandler } from "../../desktop/board-route.js";
import { setPullDeps } from "../video/handoff/pull-deps.js";
import { osascriptDialog } from "../video/handoff/dialog.js";
import { cardPanel } from "./panel.js";
import { reconcileAll } from "./reconcile.js";
import { founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { setPullDeps(null); await env.cleanup(); });

const KEYS = /douyin|xiaohongshu|bilibili|wechat_video|D[1-5]/;

async function publishedByAgent() {
  const c = await videoContent(env, "客户问你们用AI吗");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "客户问你们用AI吗-原片.mov"), "raw"), request_id: "a" });
  await put(path.join(projectRoot(env, c.id), "06-publish/publish-plan.json"), JSON.stringify({ platforms: [
    { platform: "douyin", publication: { status: "scheduled", scheduled_at: "2026-09-30T20:00:00+08:00" } },
    { platform: "bilibili", publication: { status: "scheduled", scheduled_at: "2026-09-30T20:00:00+08:00" } },
  ] }));
  await reconcileAll(env.dir);
  return c;
}

describe("Part F", () => {
  it("已发布但本轮没有登记记录：卡上与面板标「未登记就发布」；原因是人话、平台是中文名；回执叫「发布计划里的记录」", async () => {
    const c = await publishedByAgent();
    const p = await cardPanel(c.id, env.dir);
    expect(p).toMatchObject({ stage: "已发布", reason: "抖音、B站 已定时投出" });
    expect(p.alerts).toEqual(["未登记就发布：发出去的成片没有登记记录可核对"]);
    for (const b of p.badges as string[]) expect(b).not.toMatch(KEYS);
    expect((p.published as Array<{ label: string }>).every((x) => x.label === "发布计划里的记录")).toBe(true);
  });

  it("启用前的「要挪」清单：依据是人话，不带规则代码、不露平台键名", async () => {
    const shadow = await makeEnv();
    try {
      const c = await videoContent(shadow, "客户问你们用AI吗", "approved");
      await put(path.join(projectRoot(shadow, c.id), "02-aroll/raw.mov"), "raw");
      const report = await reconcileAll(shadow.dir);
      for (const m of report.moves) for (const e of m.evidence) expect(e).not.toMatch(KEYS);
      expect(report.moves[0].evidence[0]).toBe("剪辑中，还差：成片、封面(3:4)、封面(4:3)");
    } finally { await shadow.cleanup(); }
  });
});

describe("「选择文件…」（服务端弹访达选择窗）", () => {
  async function call(chooseFile: typeof osascriptDialog.chooseFile | undefined) {
    setPullDeps({ dialog: { ...osascriptDialog, chooseFile } });
    const handler = createBoardHandler({ authorize: () => "session", originAllowed: () => true, resolveDataDir: async () => env.dir, readBody: async () => "{}" });
    let text = "";
    const res = { writeHead: () => res, end: (t?: string) => { text = t ?? ""; } } as unknown as http.ServerResponse;
    await handler({ method: "POST" } as http.IncomingMessage, res, new URL("http://x/api/board/choose-file"));
    return JSON.parse(text);
  }
  it("选中 → 回路径；取消 / 弹不出 → 明说，提示贴路径", async () => {
    expect(await call(async () => ({ kind: "ok", value: "/Users/x/原片.mov" }))).toMatchObject({ ok: true, path: "/Users/x/原片.mov" });
    expect(await call(async () => ({ kind: "cancel" }))).toMatchObject({ ok: false, code: "cancelled" });
    expect(await call(async () => ({ kind: "unavailable", reason: "没有图形会话" }))).toMatchObject({ ok: false, code: "unavailable", error: expect.stringContaining("贴进来") });
    expect(await call(undefined)).toMatchObject({ ok: false, code: "unavailable" });
  });
});
