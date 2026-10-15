/**
 * start / 接手时给回这篇锁住的依据（spec 2026-10-15 §15.5）：立意时锁的范文全文和写法那一版全文。
 * 中途升级了范文库或技能，这里仍按锁住的版本取；读不了逐项报错，不悄悄换成当前版。
 * 旧稿（立意早于范文库，没有锁）照旧方式续写，不补塞范文。
 */
import type { Content } from "../storage/local-store.js";
import { lockedExemplars } from "../modules/exemplar/select.js";
import { currentMethod, lockedMethod } from "../modules/exemplar/method.js";
import { bodyHash } from "../modules/draft/draft-types.js";

type R = Record<string, unknown>;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function methodOf(version: string, dataDir?: string): Promise<R> {
  try {
    const text = await lockedMethod(version, dataDir);
    const now = await currentMethod().catch(() => null);
    return { version, text, ...(now && now.version !== version ? { note: "技能里的写法之后改过；这篇按开写时锁住的这一版写" } : {}) };
  } catch (e) {
    return { version, error: `${errText(e)}。如实告诉创始人` };
  }
}

export async function lockedContext(c: Content, dataDir?: string): Promise<R> {
  const angle = c.draftPath?.angle;
  if (!angle) return {};
  if (!angle.exemplars) return { exemplars_note: "这篇的立意早于范文库：照旧方式续写，不补塞范文" };
  let exemplars: R;
  try {
    exemplars = await lockedExemplars(angle.exemplars, dataDir) as unknown as R;
  } catch (e) {
    exemplars = { entries: [], errors: [{ id: "*", error: `范文库读不了：${errText(e)}` }] };
  }
  return { exemplars, ...(angle.method ? { method: await methodOf(angle.method.version, dataDir) } : {}) };
}

/** 进度里的开头三选一和观众试读 */
export function openingAndReads(c: Content): R {
  const pick = c.draftPath?.angle?.opening_pick;
  const reads = c.draftPath?.testReads ?? [];
  const last = reads.at(-1);
  const current = last ? last.body_hash === bodyHash(c.body ?? "") : false;
  return {
    opening_pick: pick ? { round: pick.round, candidates: pick.candidates, chosen: pick.chosen ?? null, waiting: pick.chosen ? null : pick.exhausted ? "两轮都没选中：回到立意重选" : "等你选开头" } : null,
    test_read: last ? { version: last.version, status: last.status, current, ...(current ? {} : { note: "这是修改前那版的试读" }) } : null,
  };
}
