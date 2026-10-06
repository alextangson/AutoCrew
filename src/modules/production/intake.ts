/**
 * 对话里收原片（手动收件 spec 2026-10-06 规则 1）：创始人说「原片放进去了，是《XX》那条」，agent 先列收件箱，
 * 再把他点名的那个文件挂到他点名的那条稿上。不猜：文件或稿对不上唯一一个 → 拒并给候选，让 agent 去问。
 *
 * 挂载走现有的创始人挂载（attach_aroll）：锁内再核 sha（列出之后换过字节就拒）、读得出时长、挪进项目，
 * ChatCut 工程按路径在用的留在原处。原话与发起方记进决定，来源 `chat`；request_id 幂等。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isImportedHistory } from "../../storage/imported-history.js";
import { getDataDir, listContents, type Content } from "../../storage/local-store.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { once } from "./chat-approval/decide.js";
import { isRequestId, payloadHash } from "./chat-approval/requests.js";
import { requesterOf } from "./chat-approval/view.js";
import { withProvenance } from "./decision-provenance.js";
import { founderDecision } from "./decisions.js";
import { cachedSha, unsettled } from "./hash-cache.js";
import { arollUsedBy } from "./inbox-used.js";
import { VIDEO_EXT } from "./observe.js";
import { movableRoots } from "./roots.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string, extra: Result = {}): Result => ({ ok: false, code, error, ...extra });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** 还没过剪辑的视频稿（没删、没发、没归档）：收件箱原片能挂给它们 */
const ATTACHABLE = new Set(["topic_saved", "drafting", "needs_evidence", "draft_ready", "reviewing", "revision", "approved", "editing"]);

export interface InboxFile { name: string; path: string; sha256: string; size: number; mtime_ms: number; still_copying?: true; used_by?: { content_id: string; title: string } }
interface Choice { id: string; title: string; status: string }

async function inboxDir(dataDir: string): Promise<string | null> {
  return (await movableRoots(dataDir)).inbox;
}

/** 收件箱顶层的视频（不进子目录、不看隐藏文件）；读不了目录 → 抛，调用方给人话 */
async function inboxFiles(dir: string, dataDir: string): Promise<InboxFile[]> {
  const names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith(".") && VIDEO_EXT.has(path.extname(e.name).toLowerCase())).map((e) => e.name).sort();
  const out: InboxFile[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const h = await cachedSha(file).catch(() => null);
    if (!h) continue;
    const used = await arollUsedBy(dataDir, h.sha256, file).catch(() => null);
    out.push({ name, path: file, ...h, ...(unsettled(h.mtime_ms) ? { still_copying: true as const } : {}), ...(used ? { used_by: { content_id: used.content_id, title: used.title } } : {}) });
  }
  return out;
}

function choicesOf(contents: Content[]): Choice[] {
  return contents.filter((c) => isVideoPlatform(c.platform) && !c.deletedAt && !isImportedHistory(c) && ATTACHABLE.has(c.status)).map((c) => ({ id: c.id, title: c.title, status: c.status }));
}

/** inbox_list：收件箱里的视频（带 sha，挂的时候原样带回）和能挂给的稿 */
export async function listInbox(dataDir = getDataDir()): Promise<Result> {
  const dir = await inboxDir(dataDir);
  if (!dir) return fail("no_inbox", "这个工作区没有原片收件箱（资料库没连上，或还没启用本体）");
  let files: InboxFile[];
  try { files = await inboxFiles(dir, dataDir); }
  catch (e) { return fail("inbox_unreadable", `读不了原片收件箱 ${dir}（${(e as NodeJS.ErrnoException).code ?? String(e)}）`); }
  return { ok: true, inbox: dir, files, contents: choicesOf(await listContents(dataDir)),
    next_action: files.length ? "把文件名列给创始人；他说哪个文件是哪条稿，再 inbox_attach{file, sha256, content_id, founder_words, request_id}。对不上唯一一个就先问他。" : "收件箱里没有视频：请创始人把原片放进收件箱再说。" };
}

type Pick<T> = { ok: true; value: T } | { ok: false; result: Result };

function pickFile(files: InboxFile[], q: string): Pick<InboxFile> {
  const exact = files.filter((f) => f.name === q || f.path === q);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  const near = files.filter((f) => f.name.toLowerCase().includes(path.basename(q).toLowerCase()));
  const candidates = (near.length ? near : files).map((f) => ({ name: f.name, sha256: f.sha256 }));
  return { ok: false, result: fail("ambiguous_file", files.length ? `收件箱里没有恰好叫「${q}」的视频：问创始人是哪一个，别猜` : "收件箱里没有视频", { candidates }) };
}

function pickContent(contents: Content[], q: string): Pick<Content> {
  const live = contents.filter((c) => isVideoPlatform(c.platform) && !c.deletedAt && !isImportedHistory(c));
  const byId = live.find((c) => c.id === q);
  if (byId) return { ok: true, value: byId };
  const choices = choicesOf(contents);
  const byTitle = choices.filter((c) => c.title === q);
  if (byTitle.length === 1) return { ok: true, value: live.find((c) => c.id === byTitle[0].id)! };
  const near = choices.filter((c) => q && (c.title.includes(q) || q.includes(c.title)));
  return { ok: false, result: fail("ambiguous_content", `对不上唯一一条稿「${q}」：问创始人是哪条，别猜`, { candidates: near.length ? near : choices }) };
}

export interface AttachInput { file: string; sha256: string; content_id: string; founder_words: string; request_id: string; confirm_other?: boolean; host?: unknown; session?: unknown }

function invalid(i: AttachInput): Result | null {
  if (!isRequestId(i.request_id)) return fail("invalid_params", "要带 request_id（1–100 位字母、数字、-、_），重试用同一个");
  if (!i.founder_words) return fail("founder_words_required", "带上创始人说是哪条的原话（founder_words），一字不改照抄");
  if (!i.file || !i.content_id) return fail("invalid_params", "要带 file（inbox_list 给的文件名）和 content_id（他点名的那条稿）");
  if (!/^[a-f0-9]{64}$/.test(i.sha256)) return fail("invalid_params", "要带 sha256（inbox_list 给的那个）：先 inbox_list");
  return null;
}

async function attach(i: AttachInput, dataDir: string, requester: string): Promise<Result> {
  const dir = await inboxDir(dataDir);
  if (!dir) return fail("no_inbox", "这个工作区没有原片收件箱");
  const files = await inboxFiles(dir, dataDir);
  const file = pickFile(files, i.file);
  if (!file.ok) return file.result;
  if (file.value.sha256 !== i.sha256) return fail("file_changed", "这个文件在你列出之后换过：什么都没挂，重新 inbox_list 给创始人看", { file: file.value });
  const content = pickContent(await listContents(dataDir), i.content_id);
  if (!content.ok) return content.result;
  const run = () => founderDecision(content.value.id, "attach_aroll", { path: file.value.path, expect_sha: i.sha256, ...(i.confirm_other ? { confirm_other: true } : {}) }, dataDir);
  const r = await withProvenance({ source: "chat", founder_words: i.founder_words, requested_by: requester, request_id: i.request_id }, run);
  if (r.code === "stale") return fail("file_changed", "这个文件在你列出之后换过：什么都没挂，重新 inbox_list 给创始人看");
  if (r.code === "looks_like_other") return { ...r, next_action: `把这句问创始人；他确认还是挂到《${content.value.title}》，就换一个新 request_id、带 confirm_other:true 再挂` };
  if (r.ok !== true) return r;
  return { ...r, content_id: content.value.id, title: content.value.title, file: file.value.name, recorded_as: "chat",
    next_action: `告诉创始人《${content.value.title}》的原片挂上了${typeof r.path === "string" ? `（${r.path}）` : ""}。` };
}

/** inbox_attach：把创始人点名的收件箱文件挂到他点名的稿上 */
export async function attachInbox(input: AttachInput, dataDir = getDataDir()): Promise<Result> {
  const i = { ...input, file: str(input.file), sha256: str(input.sha256).toLowerCase(), content_id: str(input.content_id), founder_words: str(input.founder_words), request_id: str(input.request_id) };
  const bad = invalid(i);
  if (bad) return bad;
  const requester = requesterOf(i.host, i.session);
  const hash = payloadHash({ intake: i.file, sha256: i.sha256, content_id: i.content_id, confirm_other: i.confirm_other === true, founder_words: i.founder_words, requester });
  return once(i.request_id, hash, dataDir, () => attach(i, dataDir, requester));
}
