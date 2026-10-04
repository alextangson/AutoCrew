/**
 * 乐观版本号（再收窄 #1）：save / angle / prepare_final 带 base_version（读到的版本号）。
 * 比对和写入在同一把单稿写锁里（contentTransaction），对不上就拒，回最新版本号和正文差异——
 * 防的是创始人在工作台手改时，agent 存稿把它盖掉。不认领、不发令牌。
 */
import { contentTransaction, getVersion, type Content, type ContentTx } from "../storage/local-store.js";
import { currentVersion } from "../modules/draft/draft-types.js";
import { stageRefusal } from "./draft-start.js";
import type { DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;
export const fail = (code: string, error: string, extra: R = {}): R => ({ ok: false, code, error, ...extra });

/** 段落级差异：基线里有、现在没了的段；现在有、基线没有的段 */
export function bodyDiff(base: string, current: string): { removed: string[]; added: string[] } {
  const split = (t: string) => t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const b = split(base), c = split(current);
  const bs = new Set(b), cs = new Set(c);
  return { removed: b.filter((l) => !cs.has(l)), added: c.filter((l) => !bs.has(l)) };
}

async function conflict(c: Content, base: number, dataDir?: string): Promise<R> {
  const latest = currentVersion(c);
  const baseBody = base > 0 ? await getVersion(c.id, base, dataDir) : "";
  return fail("version_conflict", `你基于第 ${base} 版，稿子现在是第 ${latest} 版（中间有人改过，可能是创始人在工作台手改）。读最新版、在它上面重改，再带 base_version:${latest} 提交`, {
    latest_version: latest, diff: bodyDiff(baseBody ?? "", c.body ?? ""), latest_body: c.body,
  });
}

/** 稿在、走这条路、还在写稿段、版本对得上，才在同一把锁里执行写入 */
export function withVersion(a: DraftArgs, fn: (c: Content, tx: ContentTx) => Promise<R>): Promise<R> {
  if (!a.contentId) return Promise.resolve(fail("bad_param", "要带 content_id（start 返回的那个）"));
  if (a.baseVersion === undefined) return Promise.resolve(fail("bad_param", "要带 base_version：你最后读到的版本号（start / save 回执里的 version）"));
  return contentTransaction(a.contentId, a.dataDir, async (tx) => {
    const c = await tx.read();
    if (!c) return fail("not_found", `稿件不存在：${a.contentId}`);
    if (!c.draftPath) return fail("not_started", "这篇还没用 autocrew_draft 接手：先调 start{content_id}", { next_action: { tool: "autocrew_draft", params: { action: "start", content_id: c.id } } });
    const stage = stageRefusal(c);
    if (stage) return stage;
    if (currentVersion(c) !== a.baseVersion) return conflict(c, a.baseVersion!, a.dataDir);
    return fn(c, tx);
  });
}
