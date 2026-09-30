/**
 * 分镜必须是脚本生成的审阅页（spec 2026-09-30-storyboard-review-check §3–§6，E1–E12）。
 * 合成的 html + 回执（与 build_material_review.py 同形：media[].path 相对 --root），不含真实路径。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import { createBoardHandler } from "../../desktop/board-route.js";
import { boardData } from "../../desktop/board-data.js";
import { revealProjectPath } from "../../desktop/project-reveal.js";
import { getContent } from "../../storage/local-store.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { cardPanel } from "./panel.js";
import { explainContent } from "./read.js";
import { reconcileAll } from "./reconcile.js";
import { openStoryboard, STORYBOARD_HINT } from "./storyboard.js";
import { reopenScript } from "./reopen.js";
import { founderApprove, makeEnv, projectRoot, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const sha = (b: string | Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * 在项目里造一个脚本产出的审阅页：`<dir>/<name>.html` + `<name>.receipt.json`；素材写在 `<root>/<media>`，
 * root 默认 = 审阅页所在目录（与真实工程一致），`rootRel` 可指到更上层。
 */
async function makeReview(pr: string, o: { ver?: string; name?: string; html?: string; media?: string[]; rootRel?: string } = {}) {
  const dir = path.join(pr, "03-broll", `review-${o.ver ?? "v001"}`);
  const name = o.name ?? "review";
  const root = o.rootRel ? path.join(pr, o.rootRel) : dir;
  const media = [];
  const tags: string[] = [];
  for (const m of o.media ?? ["opus/boards/B01.svg"]) {
    await fs.mkdir(path.dirname(path.join(root, m)), { recursive: true });
    const bytes = `<svg>${m}</svg>`;
    await fs.writeFile(path.join(root, m), bytes);
    media.push({ item: "B01", path: m, sha256: sha(bytes) });
    // 与脚本一样：src = 相对页面目录的路径，再做 URL 转义
    tags.push(`<img src="${encodeURI(path.relative(dir, path.join(root, m)).split(path.sep).join("/"))}" alt="B01">`);
  }
  const html = o.html ?? `<html><body>分镜 ${o.ver ?? "v001"}${tags.join("")}</body></html>`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.html`), html);
  await fs.writeFile(path.join(dir, `${name}.receipt.json`), JSON.stringify({ manifest: "/gone/display.json", manifest_sha256: "m", media, html_sha256: sha(html), approval_created: false }));
  return { dir, file: path.join(dir, `${name}.html`), receipt: path.join(dir, `${name}.receipt.json`), root };
}

async function approved(title = "AI 又忘了怎么办") {
  const c = await videoContent(env, title);
  await founderApprove(env, c.id);
  return { c, pr: projectRoot(env, c.id) };
}
/** 假子进程：下一拍发 error 或 exit */
function fakeChild(o: { exit?: number; error?: string }) {
  const child = new EventEmitter();
  setImmediate(() => (o.error ? child.emit("error", Object.assign(new Error(o.error), { code: "ENOENT" })) : child.emit("exit", o.exit ?? 0, null)));
  return child;
}
const report = (id: string, p: string, rid = "sb1") => record(env, { content_id: id, kind: "storyboard", path: p, request_id: rid });

describe("§3 只收脚本生成的审阅页（E1–E6）", () => {
  it("合规页收下：原地、带版本与回执 sha；不影响阶段", async () => {
    const { c, pr } = await approved();
    const r = await makeReview(pr);
    const res = await report(c.id, r.file);
    expect(res).toMatchObject({ ok: true, kind: "storyboard", state: "accepted", path: "03-broll/review-v001/review.html", next_action: expect.stringContaining("打开审阅页") });
    const f = (await readProductionDoc(c.id, env.dir))!.facts.find((x) => x.kind === "storyboard")!;
    expect(f).toMatchObject({ version: 1, sha256: sha(await fs.readFile(r.file)), receipt_sha256: sha(await fs.readFile(r.receipt)) });
    expect((await explainContent((await getContent(c.id, env.dir))!, env.dir)).stage).toBe("待录制");
  });

  it("E1 MD / 非 html → 拒收并指路", async () => {
    const { c, pr } = await approved();
    const md = path.join(pr, "03-broll", "review-v001", "storyboard-v001.md");
    await fs.mkdir(path.dirname(md), { recursive: true });
    await fs.writeFile(md, "# 分镜");
    expect(await report(c.id, md)).toMatchObject({ ok: false, code: "storyboard_not_review_page", error: expect.stringContaining(STORYBOARD_HINT) });
  });

  it("E2 没有回执（手写 HTML）→ 拒收", async () => {
    const { c, pr } = await approved();
    const r = await makeReview(pr);
    await fs.rm(r.receipt);
    expect(await report(c.id, r.file)).toMatchObject({ ok: false, code: "storyboard_no_receipt" });
  });

  it("E3 回执解析失败或缺字段 → 拒收", async () => {
    const { c, pr } = await approved();
    const r = await makeReview(pr);
    await fs.writeFile(r.receipt, "{not json");
    expect(await report(c.id, r.file, "a")).toMatchObject({ ok: false, code: "storyboard_bad_receipt" });
    await fs.writeFile(r.receipt, JSON.stringify({ media: [], manifest_sha256: "m" }));
    expect(await report(c.id, r.file, "b")).toMatchObject({ ok: false, code: "storyboard_bad_receipt" });
  });

  it("E4 生成后手改过 → 拒收「请用脚本重新生成」", async () => {
    const { c, pr } = await approved();
    const r = await makeReview(pr);
    await fs.appendFile(r.file, "<!-- 手改 -->");
    expect(await report(c.id, r.file)).toMatchObject({ ok: false, code: "storyboard_edited", error: expect.stringContaining("请用脚本重新生成") });
  });

  it("E5 素材缺了 / 变了 → 拒收；素材根在更上层（--root=03-broll）也认", async () => {
    const { c, pr } = await approved();
    const r = await makeReview(pr);
    await fs.writeFile(path.join(r.root, "opus/boards/B01.svg"), "changed");
    expect(await report(c.id, r.file, "a")).toMatchObject({ ok: false, code: "storyboard_media_changed" });
    await fs.rm(path.join(r.root, "opus/boards/B01.svg"));
    expect(await report(c.id, r.file, "b")).toMatchObject({ ok: false, code: "storyboard_media_changed" });
    const up = await makeReview(pr, { ver: "v002", rootRel: "03-broll", media: ["assets/B02.png"] });
    expect(await report(c.id, up.file, "c")).toMatchObject({ ok: true });
  });

  it("E6 不在本条项目 03-broll/review-vNNN/，或经符号链接 → 拒收", async () => {
    const { c, pr } = await approved();
    const other = await makeReview(pr, { ver: "v001" });
    const wrongDir = path.join(pr, "03-broll", "drafts");
    await fs.mkdir(wrongDir, { recursive: true });
    await fs.copyFile(other.file, path.join(wrongDir, "review.html"));
    await fs.copyFile(other.receipt, path.join(wrongDir, "review.receipt.json"));
    expect(await report(c.id, path.join(wrongDir, "review.html"), "a")).toMatchObject({ ok: false, code: "storyboard_outside" });
    const outside = path.join(env.outside, "03-broll", "review-v001");
    await fs.mkdir(outside, { recursive: true });
    await fs.copyFile(other.file, path.join(outside, "review.html"));
    expect(await report(c.id, path.join(outside, "review.html"), "b")).toMatchObject({ ok: false, code: "storyboard_outside" });
    // 项目里的 review-v003 是指向项目外的符号链接
    await fs.symlink(outside, path.join(pr, "03-broll", "review-v003"));
    await fs.copyFile(other.receipt, path.join(outside, "review.receipt.json"));
    expect(await report(c.id, path.join(pr, "03-broll", "review-v003", "review.html"), "c")).toMatchObject({ ok: false, code: "storyboard_outside" });
  });

  it("E12 本体没启用的库：record 本就拒", async () => {
    const off = await makeEnv();
    try {
      const c = await videoContent(off, "AI 又忘了怎么办");
      const pr = projectRoot(off, c.id);
      const r = await makeReview(pr);
      expect(await record(off, { content_id: c.id, kind: "storyboard", path: r.file, request_id: "x" })).toMatchObject({ ok: false, code: "ontology_not_enabled" });
    } finally { await off.cleanup(); }
  });
});

describe("§4 事实与显示（E7–E11）", () => {
  it("E7 同一文件重复报 → 幂等（换 request_id 也只一条）", async () => {
    const { c, pr } = await approved();
    const r = await makeReview(pr);
    const a = await report(c.id, r.file, "a"), b = await report(c.id, r.file, "b"), again = await report(c.id, r.file, "a");
    expect(b.fact_id).toBe(a.fact_id);
    expect(again).toMatchObject({ replayed: true, fact_id: a.fact_id });
    expect((await readProductionDoc(c.id, env.dir))!.facts.filter((f) => f.kind === "storyboard")).toHaveLength(1);
  });

  it("E8 多版本：面板最新一版在前、旧版折叠；看板卡片信息行带「分镜 v002」", async () => {
    const { c, pr } = await approved();
    await report(c.id, (await makeReview(pr, { ver: "v001" })).file, "a");
    await report(c.id, (await makeReview(pr, { ver: "v002" })).file, "b");
    const panel = await cardPanel(c.id, env.dir) as { storyboard: { latest: { version: string; changed: boolean }; older: Array<{ version: string }> } };
    expect(panel.storyboard.latest).toMatchObject({ version: "v002", changed: false });
    expect(panel.storyboard.older.map((o) => o.version)).toEqual(["v001"]);
    expect((await boardData(env.dir)).items.find((i) => i.id === c.id)).toMatchObject({ storyboard: "v002" });
  });

  it("E9 报上之后被改过 → 卡片提示；对账把事实标成字节已换", async () => {
    const { c, pr } = await approved();
    const r = await makeReview(pr);
    await report(c.id, r.file);
    await fs.appendFile(r.file, "<!-- 后来改的 -->");
    const panel = await cardPanel(c.id, env.dir) as { storyboard: { latest: { changed: boolean; note?: string } } };
    expect(panel.storyboard.latest).toMatchObject({ changed: true, note: "审阅页在报上之后被改过" });
    await reconcileAll(env.dir);
    expect((await readProductionDoc(c.id, env.dir))!.facts.find((f) => f.kind === "storyboard")!.replaced_at).toBeTruthy();
  });

  it("E10 「打开审阅页」只走浏览器会话、只认事实里的路径；访达定位按事实 sha", async () => {
    const { c, pr } = await approved();
    const r = await makeReview(pr);
    const fact = await report(c.id, r.file);
    const opened: string[][] = [];
    const call = async (body: unknown, auth: "session" | "bearer" = "session") => {
      const handler = createBoardHandler({ authorize: () => auth, originAllowed: () => true, resolveDataDir: async () => env.dir, readBody: async () => JSON.stringify(body),
        storyboard: { platform: "darwin", spawnImpl: ((cmd: string, args: string[]) => { opened.push([cmd, ...args]); return fakeChild({ exit: 0 }); }) as never } });
      let status = 0, text = "";
      const res = { writeHead: (s: number) => { status = s; return res; }, end: (t?: string) => { text = t ?? ""; } } as unknown as http.ServerResponse;
      await handler({ method: "POST" } as http.IncomingMessage, res, new URL("http://x/api/board/open-storyboard"));
      return { status, json: text ? JSON.parse(text) : null };
    };
    expect((await call({ content_id: c.id, fact_id: fact.fact_id }, "bearer")).status).toBe(403);
    expect((await call({ content_id: c.id, fact_id: "fact-other", path: "/etc/passwd" })).json).toMatchObject({ ok: false, code: "not_allowed" });
    expect((await call({ content_id: c.id, fact_id: fact.fact_id })).json).toMatchObject({ ok: true, opened: true });
    expect(opened).toEqual([["open", await fs.realpath(r.file)]]);
    const shaOf = (await readProductionDoc(c.id, env.dir))!.facts.find((f) => f.kind === "storyboard")!.sha256!;
    expect(await revealProjectPath(c.id, shaOf, env.dir, { platform: "linux" })).toMatchObject({ ok: true, path: await fs.realpath(r.file), opened: false });
  });

  it("E11 对账只导入合规页（source=reconcile），不合规的静默跳过", async () => {
    const { c, pr } = await approved();
    await makeReview(pr, { ver: "v001" });
    const edited = await makeReview(pr, { ver: "v001", name: "review-checked" });
    await fs.appendFile(edited.file, "x");
    await fs.writeFile(path.join(pr, "03-broll", "review-v001", "index.html"), "<html>中间文件</html>");
    await fs.writeFile(path.join(pr, "03-broll", "review-v001", "notes.md"), "# 草稿");
    const rep = await reconcileAll(env.dir);
    expect(rep.errors).toEqual([]);
    const boards = (await readProductionDoc(c.id, env.dir))!.facts.filter((f) => f.kind === "storyboard");
    expect(boards.map((f) => [f.path, f.source])).toEqual([["03-broll/review-v001/review.html", "reconcile"]]);
  });
});

describe("Codex 审 storyboard 回归", () => {
  it("[P2 storyboard.ts:87] 页面实际引用的素材不见了，上层目录有同名同 hash 的文件也不算", async () => {
    const { c, pr } = await approved();
    const r = await makeReview(pr, { media: ["assets/shot.svg"] });
    await fs.mkdir(path.join(pr, "03-broll", "assets"), { recursive: true });
    await fs.rename(path.join(r.dir, "assets", "shot.svg"), path.join(pr, "03-broll", "assets", "shot.svg"));
    expect(await report(c.id, r.file)).toMatchObject({ ok: false, code: "storyboard_media_changed" });
    await reconcileAll(env.dir);
    expect((await readProductionDoc(c.id, env.dir))!.facts.filter((f) => f.kind === "storyboard")).toEqual([]);
  });

  it("[P2 record.ts:275] 重开文稿后重报同一份页面：不跨轮次重复记，最新 / 历史里只出现一次", async () => {
    const { c, pr } = await approved();
    const r = await makeReview(pr);
    const a = await report(c.id, r.file, "a");
    expect(await reopenScript(c.id, env.dir, undefined, 1)).toMatchObject({ ok: true, round: 2 });
    const b = await report(c.id, r.file, "b");
    expect(b.fact_id).toBe(a.fact_id);
    const panel = await cardPanel(c.id, env.dir) as { storyboard: { latest: { fact_id: string }; older: unknown[] } };
    expect(panel.storyboard).toMatchObject({ latest: { fact_id: a.fact_id }, older: [] });
  });

  it("[P2 storyboard.ts:133] open 启动失败 / 非零退出：回失败并说原因，不回成功", async () => {
    const { c, pr } = await approved();
    const fact = await report(c.id, (await makeReview(pr)).file);
    const run = (o: { exit?: number; error?: string }) => openStoryboard(c.id, String(fact.fact_id), env.dir, { platform: "darwin", spawnImpl: (() => fakeChild(o)) as never });
    expect(await run({ error: "spawn open ENOENT" })).toMatchObject({ ok: false, code: "open_failed", error: expect.stringContaining("ENOENT") });
    expect(await run({ exit: 1 })).toMatchObject({ ok: false, code: "open_failed", error: expect.stringContaining("退出码 1") });
    expect(await run({ exit: 0 })).toMatchObject({ ok: true, opened: true });
  });
});
