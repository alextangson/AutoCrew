/**
 * 看板与数据页的浏览器会话端点（不是 MCP 能力）：读看板、「开始写」、「我发了」/撤销；
 * 读数据页、数据↔稿件的手动关联 / 合并 / 拆开及撤销（数据页规格 §F）。
 * 写操作只给浏览器会话 + 同源；打开 Claude 桌面版的命令由服务端拼，浏览器传不进链接。
 */
import type http from "node:http";
import { boardData } from "./board-data.js";
import { dataPage } from "./data-page.js";
import { createCoverHandler } from "./data-cover-route.js";
import { addDecision, removeDecision, type LinkOp } from "../modules/flywheel/outcome-links.js";
import { markPublished, startWriting, unmarkPublished, type OpenDeps } from "./board-actions.js";
import { reopenScript } from "../modules/production/reopen.js";
import { enableOntology } from "../modules/production/enable.js";
import { decide, decideItem, type DecideDeps } from "../modules/production/inbox-decide.js";
import { readInbox } from "../modules/production/inbox-read.js";
import { ATTACHMENT_HEADERS, openAttachment, openFactMedia, type AttachmentOpen } from "../modules/production/inbox-attachment.js";
import { createReadStream } from "node:fs";
import { parseRangeHeader } from "./video-media.js";
import { cardPanel } from "../modules/production/panel.js";
import { openStoryboard, type OpenDeps as StoryboardOpenDeps } from "../modules/production/storyboard.js";
import { pullDeps } from "../modules/video/handoff/pull-deps.js";
import { isContentId } from "../storage/entity-id.js";
import { applyArollSourceOp } from "../modules/production/sources.js";
import { arollSourcesView, revealFactPath, revealSourcePath, type RevealSourceDeps } from "../modules/production/sources-view.js";

export interface BoardRouteDeps {
  authorize: (req: http.IncomingMessage) => "session" | "bearer" | null;
  originAllowed: (req: http.IncomingMessage) => boolean;
  resolveDataDir: () => Promise<string>;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  open?: OpenDeps;
  /** 测试注入：不真开浏览器 */
  storyboard?: StoryboardOpenDeps;
  /** 测试注入：不真开访达 */
  reveal?: RevealSourceDeps;
  /** 测试注入：发布检查重跑用的 Jev、时钟 */
  inbox?: DecideDeps;
}

const JSON_TYPE = "application/json; charset=utf-8";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store" }).end(JSON.stringify(body));
}

async function jsonBody(req: http.IncomingMessage, readBody: BoardRouteDeps["readBody"]): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readBody(req)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("请求体要是对象");
  return parsed as Record<string, unknown>;
}

/**
 * 请示附件与条目预览共用的发送（整分支审 3 P2）：只读、sandbox + nosniff、只认绑定的 sha（打开时已核）；
 * 支持 Range（拖动进度、moov 在尾部的视频预读），越界回 416。
 */
function sendMedia(req: http.IncomingMessage, res: http.ServerResponse, r: AttachmentOpen): void {
  if (!r.ok) { res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", ...ATTACHMENT_HEADERS }).end(JSON.stringify({ ok: false, error: r.error })); return; }
  const range = parseRangeHeader(req.headers?.range, r.size);
  if (range === "unsatisfiable") { res.writeHead(416, { "Content-Range": `bytes */${r.size}`, ...ATTACHMENT_HEADERS }).end(); return; }
  res.writeHead(range ? 206 : 200, { "Content-Type": r.type, "Accept-Ranges": "bytes", "Content-Length": String(range ? range.end - range.start + 1 : r.size),
    ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${r.size}` } : {}), ...ATTACHMENT_HEADERS });
  // 核过之后文件被挪 / 删：读流报错只断这一个响应，不让未处理的 error 把整个服务带倒（整分支审 12 P2）
  const stream = createReadStream(r.file, range ?? undefined);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

export function createBoardHandler(deps: BoardRouteDeps) {
  const writeAllowed = (req: http.IncomingMessage) => deps.authorize(req) === "session" && deps.originAllowed(req);
  const post = async (req: http.IncomingMessage, res: http.ServerResponse, act: (body: Record<string, unknown>, dir: string) => Promise<unknown>) => {
    if (!writeAllowed(req)) { res.writeHead(403).end(); return; }
    try { send(res, 200, await act(await jsonBody(req, deps.readBody), await deps.resolveDataDir())); }
    catch (e) { send(res, 400, { ok: false, code: "bad_request", error: e instanceof Error ? e.message : String(e) }); }
  };
  const covers = createCoverHandler(deps);
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (await covers(req, res, url)) return true;
    if (p === "/api/board" && req.method === "GET") {
      if (deps.authorize(req) !== "session") { res.writeHead(403).end(); return true; }
      try { send(res, 200, { ok: true, data: await boardData(await deps.resolveDataDir()) }); }
      catch (e) { send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    // 卡片面板（本体 §10）：阶段、还差什么、候选、待核回执、我发了、核对清单
    if (p === "/api/board/card" && req.method === "GET") {
      if (deps.authorize(req) !== "session") { res.writeHead(403).end(); return true; }
      const id = url.searchParams.get("content_id") ?? "";
      if (!isContentId(id)) { send(res, 400, { ok: false, code: "bad_request", error: "content_id 不对" }); return true; }
      try { send(res, 200, await cardPanel(id, await deps.resolveDataDir())); }
      catch (e) { send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    // 等你拍板（review-inbox §3）：列表只读推导；决定只有一个入口（带 item_id + gen，锁内 CAS）
    if (p === "/api/inbox" && req.method === "GET") {
      if (deps.authorize(req) !== "session") { res.writeHead(403).end(); return true; }
      try { send(res, 200, await readInbox(await deps.resolveDataDir())); }
      catch (e) { send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/inbox/decide" && req.method === "POST") {
      await post(req, res, async (b, dir) => {
        const params = Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith("_")));
        if (params.content_id !== undefined && !isContentId(String(params.content_id))) return { ok: false, code: "bad_request", error: "content_id 不对" };
        return decideItem(params, dir, deps.inbox);
      });
      return true;
    }
    // 请示附件（§5.4）：只读、sandbox + nosniff、只认绑定时的 sha；HTML 不从这里给
    if (p === "/api/inbox/attachment" && req.method === "GET") {
      if (deps.authorize(req) !== "session") { res.writeHead(403).end(); return true; }
      const id = url.searchParams.get("content_id") ?? "", ask = url.searchParams.get("ask_id") ?? "", index = Number(url.searchParams.get("index") ?? "-1");
      if (!isContentId(id) || !/^ask-[\w-]+$/.test(ask) || !Number.isInteger(index) || index < 0) { send(res, 400, { ok: false, error: "参数不对" }); return true; }
      try {
        sendMedia(req, res, await openAttachment(id, ask, index, await deps.resolveDataDir()));
      } catch (e) { send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    // 条目预览（成片 / 封面 / 候选）：按 fact_id 取，条目里不放路径；支持拖动进度（Range）
    if (p === "/api/inbox/media" && req.method === "GET") {
      if (deps.authorize(req) !== "session") { res.writeHead(403).end(); return true; }
      const id = url.searchParams.get("content_id") ?? "", fid = url.searchParams.get("fact_id") ?? "";
      if (!isContentId(id) || !/^[\w-]{1,80}$/.test(fid)) { send(res, 400, { ok: false, error: "参数不对" }); return true; }
      try {
        sendMedia(req, res, await openFactMedia(id, fid, await deps.resolveDataDir()));
      } catch (e) { send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/data" && req.method === "GET") {
      if (deps.authorize(req) !== "session") { res.writeHead(403).end(); return true; }
      try { send(res, 200, { ok: true, data: await dataPage(await deps.resolveDataDir()) }); }
      catch (e) { send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/data/link" && req.method === "POST") {
      await post(req, res, async (b, dir) => ({ ok: true, data: await addDecision({
        op: String(b.op ?? "") as LinkOp,
        works: Array.isArray(b.works) ? b.works.map(String) : [],
        ...(typeof b.content_id === "string" ? { contentId: b.content_id } : {}),
        ...(typeof b.target === "string" ? { target: b.target } : {}),
      }, dir) }));
      return true;
    }
    if (p === "/api/data/undo" && req.method === "POST") {
      await post(req, res, async (b, dir) => ({ ok: true, data: await removeDecision(String(b.id ?? ""), dir) }));
      return true;
    }
    if (p === "/api/board/start-writing" && req.method === "POST") {
      await post(req, res, (b, dir) => startWriting(String(b.topic_id ?? ""), typeof b.platform === "string" ? b.platform : undefined, dir, deps.open));
      return true;
    }
    // 本体（spec 2026-09-29）：两个创始人决定只走浏览器会话——重开文稿（§2.5）与启用本体（§4.1）
    if (p === "/api/board/reopen-script" && req.method === "POST") {
      await post(req, res, async (b, dir) => {
        const id = String(b.content_id ?? "");
        if (!isContentId(id)) return { ok: false, code: "bad_request", error: "content_id 不对" };
        if (b.confirm !== true) return { ok: false, code: "confirmation_required", error: "重开文稿会把本轮的原片、成片、批准转入历史，需要确认" };
        const round = Number(b.round);
        if (!Number.isInteger(round) || round < 1) return { ok: false, code: "bad_request", error: "要带你看到的轮次（round），刷新后再点" };
        return reopenScript(id, dir, typeof b.note === "string" ? b.note.slice(0, 200) : undefined, round);
      });
      return true;
    }
    // 创始人决定（§2.4）：确认候选 / 不是这条、成片通过 / 打回、用这一版封面、撤销批准、我发了 / 确认回执 / 纠正
    if (p === "/api/board/decision" && req.method === "POST") {
      await post(req, res, async (b, dir) => {
        const id = String(b.content_id ?? "");
        if (!isContentId(id)) return { ok: false, code: "bad_request", error: "content_id 不对" };
        // 浏览器请求体里的 _host / _modelCall 不许借来冒充什么：剥掉内部键，决定只认会话本身
        const params = Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith("_")));
        // 等你拍板 R18：卡片上的旧决定也走同一个入口（带代次则 CAS，旧页面按指纹找条目取代次）
        return decide(id, String(b.action ?? ""), params, dir, deps.inbox);
      });
      return true;
    }
    // 「打开审阅页」（分镜 spec E10）：浏览器会话 + 同源；只带 fact_id，服务端按事实里的路径打开
    if (p === "/api/board/open-storyboard" && req.method === "POST") {
      await post(req, res, async (b, dir) => {
        const id = String(b.content_id ?? "");
        if (!isContentId(id)) return { ok: false, code: "bad_request", error: "content_id 不对" };
        return openStoryboard(id, String(b.fact_id ?? ""), dir, deps.storyboard);
      });
      return true;
    }
    // 卡片挂 A-roll 的「选择文件…」（本体 §9.1-3）：服务端在创始人的 Mac 上弹访达选择窗，只回路径，挂载仍走 attach_aroll 决定
    if (p === "/api/board/choose-file" && req.method === "POST") {
      await post(req, res, async () => {
        const chooser = pullDeps().dialog.chooseFile;
        if (!chooser) return { ok: false, code: "unavailable", error: "这台机器上弹不出选择文件的窗口，请把路径贴进来" };
        const r = await chooser({ prompt: "选这条的原片（A-roll）", timeoutSec: 300 });
        if (r.kind === "ok") return { ok: true, path: r.value };
        if (r.kind === "cancel") return { ok: false, code: "cancelled", error: "没选文件" };
        if (r.kind === "timeout") return { ok: false, code: "timeout", error: "选择窗等太久关掉了，再点一次" };
        return { ok: false, code: "unavailable", error: `弹不出选择文件的窗口（${r.reason}），请把路径贴进来` };
      });
      return true;
    }
    // 「原片放哪里」：读只要会话；写（剪映导出目录）只收同源浏览器会话（可搬入根，§14-7）
    if (p === "/api/board/aroll-sources" && req.method === "GET") {
      if (deps.authorize(req) !== "session") { res.writeHead(403).end(); return true; }
      try { send(res, 200, await arollSourcesView(await deps.resolveDataDir())); }
      catch (e) { send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/board/aroll-sources" && req.method === "POST") {
      await post(req, res, (b, dir) => applyArollSourceOp(String(b.op ?? ""), b, dir));
      return true;
    }
    if (p === "/api/board/reveal-source" && req.method === "POST") {
      await post(req, res, (b, dir) => (typeof b.fact_id === "string" && isContentId(String(b.content_id ?? ""))
        ? revealFactPath(String(b.content_id), b.fact_id, dir, deps.reveal)
        : revealSourcePath(String(b.path ?? ""), dir, deps.reveal)));
      return true;
    }
    if (p === "/api/board/ontology/enable" && req.method === "POST") {
      await post(req, res, async (b, dir) => (b.confirm === true
        ? enableOntology(dir, { exclude: Array.isArray(b.exclude) ? b.exclude.map(String).filter(isContentId) : [] })
        : { ok: false, code: "confirmation_required", error: "启用前先看差异清单并确认" }));
      return true;
    }
    if (p === "/api/board/mark-published" && req.method === "POST") {
      await post(req, res, (b, dir) => b.undo === true
        ? unmarkPublished(String(b.content_id ?? ""), String(b.platform ?? ""), dir)
        : markPublished(String(b.content_id ?? ""), String(b.platform ?? ""), b.url, dir));
      return true;
    }
    return false;
  };
}
