/**
 * P1-1（验收）：启用本体后打开剪辑中稿件的工作台白屏。走真实路由 /api/project-review 拿 JSON，再渲染看板本体。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import type http from "node:http";
// react 只装在 frontend/ 里：从那里取（看板组件本身也在 frontend/，按它自己的位置解析）
const { createElement } = await import("../../../frontend/node_modules/react/index.js") as typeof import("react");
const { renderToStaticMarkup } = await import("../../../frontend/node_modules/react-dom/server.node.js") as typeof import("react-dom/server");
import { createProjectReviewHandler } from "../../desktop/project-review-route.js";
import { ProjectBoardView } from "../../../frontend/src/views/ProjectBoard";
import { founderApprove, makeEnv, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

async function routeJson(dataDir: string, id: string): Promise<Record<string, unknown>> {
  const handler = createProjectReviewHandler({ authorize: () => "session", originAllowed: () => true, resolveDataDir: async () => dataDir, readBody: async () => "" });
  let body = "";
  const res = { writeHead: () => res, end: (b?: string) => { body = b ?? ""; return res; } } as unknown as http.ServerResponse;
  await handler({ method: "GET", headers: {} } as http.IncomingMessage, res, new URL(`http://x/api/project-review?content_id=${id}`));
  return JSON.parse(body) as Record<string, unknown>;
}

describe("本体稿的工作台（P1-1）", () => {
  for (const withAroll of [true, false]) {
    it(`剪辑中${withAroll ? "（已收原片）" : "（还没原片）"}：路由返回的 review 能渲染出看板，不白屏`, async () => {
      const c = await videoContent(env, "AI 又忘了怎么办");
      await founderApprove(env, c.id);
      if (withAroll) await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
      const review = await routeJson(env.dir, c.id);
      expect(review.ontology).toBe(true);
      const html = renderToStaticMarkup(createElement(ProjectBoardView, {
        content: { id: c.id, status: "editing", title: c.title, body: c.body ?? "" }, reload: async () => {}, now: Date.now(),
        review: review as never, error: "", refreshError: "", lastOkAt: null, busy: false, submit: async () => true,
      }));
      expect(html).toContain("交接详情");
      expect(html).toContain(withAroll ? "原片.mov" : "还没有收到原片");
    });
  }
});
