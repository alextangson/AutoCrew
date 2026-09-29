/** 重开文稿 / 启用本体只走创始人的浏览器会话（§2.4 决定只由创始人产生），且要确认 */
import { afterEach, beforeEach, expect, it } from "vitest";
import type http from "node:http";
import path from "node:path";
import { createBoardHandler } from "../../desktop/board-route.js";
import { isOntologyEnabled, readProductionDoc } from "../../storage/production-store.js";
import { founderApprove, makeEnv, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv(); });
afterEach(async () => { await env.cleanup(); });

async function call(p: string, body: unknown, auth: "session" | "bearer" = "session") {
  const handler = createBoardHandler({
    authorize: () => auth, originAllowed: () => true, resolveDataDir: async () => env.dir, readBody: async () => JSON.stringify(body),
  });
  let status = 0, text = "";
  const res = { writeHead: (s: number) => { status = s; return res; }, end: (t?: string) => { text = t ?? ""; } } as unknown as http.ServerResponse;
  await handler({ method: "POST" } as http.IncomingMessage, res, new URL(`http://x${p}`));
  return { status, json: text ? JSON.parse(text) : null };
}

it("宿主令牌（bearer）调不了；不带 confirm 不动", async () => {
  expect((await call("/api/board/ontology/enable", { confirm: true }, "bearer")).status).toBe(403);
  expect((await call("/api/board/ontology/enable", {})).json).toMatchObject({ ok: false, code: "confirmation_required" });
  expect(await isOntologyEnabled(env.dir)).toBe(false);
  expect((await call("/api/board/ontology/enable", { confirm: true })).json).toMatchObject({ ok: true });
  expect(await isOntologyEnabled(env.dir)).toBe(true);
});

it("重开文稿：确认后 round+1", async () => {
  await call("/api/board/ontology/enable", { confirm: true });
  const c = await videoContent(env, "AI 又忘了怎么办");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "r1" });
  expect((await call("/api/board/reopen-script", { content_id: c.id })).json).toMatchObject({ code: "confirmation_required" });
  expect((await call("/api/board/reopen-script", { content_id: c.id, confirm: true }, "bearer")).status).toBe(403);
  expect((await call("/api/board/reopen-script", { content_id: c.id, confirm: true })).json).toMatchObject({ ok: true, round: 2 });
  expect((await readProductionDoc(c.id, env.dir))!.round).toBe(2);
});
