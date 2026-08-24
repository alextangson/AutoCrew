/**
 * 素材直传端点：`POST /api/upload?name=<原始文件名>`。
 *
 * 为什么要它：浏览器拿不到本地绝对路径（`dialog:pick_media` 在 server 模式是坏的），
 * 于是「把一条 A-roll 递给系统」的唯一走法曾是去素材库页手抄绝对路径。文件本来就在
 * 人手上，让人替浏览器打字是这条流水线最没道理的一步。
 *
 * 四条纪律：
 * 1. **鉴权与写闸沿用 server 那套**：调用方注入 `authorize` / `writeAllowed`
 *    （= session cookie / bearer + Origin 判定），本模块不发明第二套凭证。
 * 2. **全程流式**：req 直接 pipe 进 `.part`，落定后 rename。A-roll 是 GB 级的，
 *    任何「先读进内存再写盘」的写法在真机上就是把编辑部拖死。
 * 3. **落点钉死在 `<dataDir>/library/uploads/<时间戳>/`**：每次直传独占一个目录，
 *    文件名清洗成单段安全名（穿越/控制字符一律抹掉），撞名不可能，
 *    原文件名保留——素材库里那条得是人认得出的名字。
 * 4. **半截文件必须消失**：客户端中断、磁盘写挂、传了个空文件，都要清干净再报人话；
 *    留下半截字节的下场是素材库里多一条打不开的「素材」。
 */
import type http from "node:http";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { uploadsDir } from "../storage/library-store.js";

export const UPLOAD_PATH = "/api/upload";

/**
 * 目录分隔符、控制字符与各平台保留字符：进不了文件名，也进不了路径。
 * 控制字符正是这里要清掉的东西（文件名里塞 NUL 是攻击不是手滑），所以那条 lint 规则得关。
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = new RegExp("[\\u0000-\\u001f\\u007f/\\\\:*?\"<>|]", "g");

export interface UploadDeps {
  /** 当前工作区 dataDir（server 端解析，前端永远传不进路径） */
  resolveDataDir: () => Promise<string>;
  /** server 的鉴权判定：true = 已认证 */
  authorize: (req: http.IncomingMessage) => boolean;
  /** 浏览器写闸：与 /api/invoke 同一套 Origin 判定 */
  writeAllowed: (req: http.IncomingMessage) => boolean;
}

/**
 * 原始文件名 → 单段安全文件名。目录段一律丢弃（`../../etc/passwd` 只剩 `passwd`），
 * `..` 抹平，首部的点与空白去掉；空名兜底 `upload`。
 * 中文/emoji 一概保留——直传素材的名字是人认它的唯一线索，清洗不该把它清成乱码。
 */
export function sanitizeUploadName(raw: string): string {
  const last = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = last.replace(UNSAFE_CHARS, "").replace(/\.{2,}/g, ".").replace(/^[.\s]+/, "").trim();
  if (!cleaned) return "upload";
  const ext = path.extname(cleaned).slice(0, 16);
  const stem = cleaned.slice(0, cleaned.length - path.extname(cleaned).length).slice(0, 80);
  return (stem || "upload") + ext;
}

function replyJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 每次直传独占一个时间戳目录：文件名保持原样，撞名与穿越同时消失 */
async function prepareTarget(dataDir: string, rawName: string): Promise<{ dir: string; file: string }> {
  const dir = path.join(uploadsDir(dataDir), `${Date.now()}-${randomBytes(4).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true });
  return { dir, file: path.join(dir, sanitizeUploadName(rawName)) };
}

/** 落盘一次直传。任何一步失败都把整个时间戳目录端掉，绝不留半截字节 */
async function receiveFile(
  req: http.IncomingMessage,
  dataDir: string,
  rawName: string,
): Promise<{ ok: true; path: string; size: number } | { ok: false; status: number; error: string }> {
  let dir: string | null = null;
  try {
    const target = await prepareTarget(dataDir, rawName);
    dir = target.dir;
    await pipeline(req, createWriteStream(`${target.file}.part`));
    const size = (await fs.stat(`${target.file}.part`)).size;
    if (size === 0) {
      await fs.rm(dir, { recursive: true, force: true });
      return { ok: false, status: 400, error: "上传到的内容是空的（0 字节）——文件可能没选中，或已被移走" };
    }
    await fs.rename(`${target.file}.part`, target.file);
    return { ok: true, path: target.file, size };
  } catch (err) {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, status: 500, error: `上传中断或写盘失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 处理一次直传。返回 false = 这不是直传路径，交回 server 继续路由；
 * true = 响应已写完（含各种拒绝）。
 */
export function createUploadHandler(
  deps: UploadDeps,
): (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => Promise<boolean> {
  return async (req, res, pathname) => {
    if (pathname !== UPLOAD_PATH) return false;
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return true;
    }
    if (!deps.authorize(req)) {
      replyJson(res, 401, { ok: false, error: "未认证——请从 server 打印的链接重新进入编辑部" });
      return true;
    }
    if (!deps.writeAllowed(req)) {
      replyJson(res, 403, { ok: false, error: "bad origin" });
      return true;
    }
    const rawName = new URL(req.url || UPLOAD_PATH, "http://127.0.0.1").searchParams.get("name") || "upload";
    const result = await receiveFile(req, await deps.resolveDataDir(), rawName);
    if (!result.ok) {
      replyJson(res, result.status, { ok: false, error: result.error });
      return true;
    }
    replyJson(res, 200, { ok: true, path: result.path, size: result.size });
    return true;
  };
}
