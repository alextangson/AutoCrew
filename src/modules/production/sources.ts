/**
 * 「原片放哪里」设置页的写口（1b §5，手动收件 spec 2026-10-06 后只剩剪映导出目录）。
 *
 * 只有同源浏览器会话能改（board-route），`video:settings_set` / MCP / bearer 一律拒（§14-7）：它是「可搬入根」，服务端凭据。
 * 监视文件夹与「暂停自动找原片」已随自动找原片删掉；旧页面再发这些操作 → 说清楚已经没有了。
 */
import { jianyingDirError, mutateVideoSettings } from "../../desktop/settings-video.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string): Result => ({ ok: false, code, error });

const RETIRED = new Set(["add_folder", "remove_folder", "set_folder", "set_paused"]);

async function setJianying(b: Record<string, unknown>, dataDir: string): Promise<Result> {
  const v = b.path;
  const r = await mutateVideoSettings(dataDir, async (next) => {
    if (v === null || v === "") { delete next.jianyingExportDir; return null; }
    const bad = await jianyingDirError(v);
    if (bad) return bad;
    next.jianyingExportDir = String(v).trim();
    return null;
  });
  return r.ok ? { ok: true } : fail("bad_folder", r.error);
}

/** 浏览器会话路由的唯一写口。调用方（board-route）已核过「同源浏览器会话」 */
export async function applyArollSourceOp(op: string, b: Record<string, unknown>, dataDir: string): Promise<Result> {
  if (op === "set_jianying") return setJianying(b, dataDir);
  if (RETIRED.has(op)) return fail("retired", "监视文件夹和自动找原片已经停用：原片放进收件箱后，在对话里告诉 agent 是哪条");
  return fail("bad_request", `不认识的操作：${op}`);
}
