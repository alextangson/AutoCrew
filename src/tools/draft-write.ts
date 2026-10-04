/**
 * 薄路径写动作的共同外壳（Codex 复审 P1）：认领、阶段判断、写入在同一把按稿件的锁里做完，
 * 写入那一刻再核一次认领还是这枚令牌（fencing）——两个会话同时写一篇没人认领的稿，只有一个能成。
 */
import { getContent, type Content } from "../storage/local-store.js";
import { fenceDraftWrite, gateDraftWrite } from "../modules/draft/draft-claims.js";
import { serializeDraft } from "../modules/draft/draft-research.js";
import { stageRefusal } from "./draft-start.js";
import type { DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;
export const fail = (code: string, error: string, extra: R = {}): R => ({ ok: false, code, error, ...extra });

export interface WriteCtx {
  content: Content;
  /** 写入前调用：null = 认领还在你手上；否则原样返回这条拒绝 */
  fenced: () => Promise<R | null>;
}

const LOST = "这篇刚被另一个会话接管了：你手上的写入作废，照实告诉创始人。";

async function precheck(a: DraftArgs): Promise<Content | R> {
  const content = await getContent(a.contentId!, a.dataDir);
  if (!content) return fail("not_found", `稿件不存在：${a.contentId}`);
  if (!content.draftPath) return fail("not_started", "这篇还没用 autocrew_draft 接手：先调 start{content_id}", { next_action: { tool: "autocrew_draft", params: { action: "start", content_id: content.id } } });
  return stageRefusal(content) ?? content;
}

export function withDraftWrite(a: DraftArgs, fn: (ctx: WriteCtx) => Promise<R>): Promise<R> {
  if (!a.contentId) return Promise.resolve(fail("bad_param", "要带 content_id（start 返回的那个）"));
  const id = a.contentId;
  return serializeDraft(`write:${id}`, async () => {
    const checked = await precheck(a);
    if (!("draftPath" in checked) || (checked as R).ok === false) return checked as R;
    const gate = await gateDraftWrite(id, { host: a.host, session: a.session, dataDir: a.dataDir, claimToken: a.claimToken }, a.takeover);
    if (!gate.ok) return gate as R;
    const fenced = async () => (await fenceDraftWrite(id, gate.token, a.dataDir) ? null : fail("claim_lost", LOST));
    const r = await fn({ content: checked as Content, fenced });
    // 没会话的调用：令牌只能随回执交还——动作本身失败（如引文没对上）也要交，不然下一次写就被自己的认领挡住
    return gate.issued ? { ...r, claim_token: gate.issued } : r;
  });
}
