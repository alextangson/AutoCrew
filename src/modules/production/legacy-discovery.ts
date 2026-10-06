/**
 * 自动找原片停用之后的旧数据收尾（手动收件 spec 2026-10-06 规则 5）：
 * 停用前留下的 pending_match（「正在听开头核对」）不会再有人来核，启动时一次性转成候选并写明原因，
 * 预留随之放掉；创始人在对话里说是哪条（或在卡片上点「是这条」）照常收。已自动挂上的原片、已有候选与决定都不动。
 */
import { getContent } from "../../storage/local-store.js";
import { isImportedHistory } from "../../storage/imported-history.js";
import { withFileOwnership } from "./mutex.js";
import { mutateProduction, registerReadyHook } from "./service.js";
import { shaIndex } from "./sha-index.js";

export const PENDING_RETIRED = "自动核对已停用：这段原片是不是这条，等创始人说一声";

export async function settleLegacyPendingMatch(dataDir: string): Promise<number> {
  const ids = new Set<string>();
  for (const list of Object.values((await shaIndex(dataDir)).entries)) for (const e of list) if (e.state === "pending_match") ids.add(e.content_id);
  let n = 0;
  for (const id of ids) {
    const c = await getContent(id, dataDir);
    if (!c || isImportedHistory(c)) continue;
    n += (await withFileOwnership(() => mutateProduction(id, dataDir, (doc) => {
      const hit = doc.facts.filter((f) => f.state === "pending_match");
      for (const f of hit) {
        Object.assign(f, { state: "candidate", evidence: PENDING_RETIRED });
        const req = f.request_id ? doc.requests?.[f.request_id] : undefined;
        if (req) req.receipt = { ...req.receipt, state: "candidate", reason: PENDING_RETIRED };
      }
      return { value: hit.length, events: hit.map((f) => ({ type: "aroll_match_retired", detail: { fact_id: f.id, reason: PENDING_RETIRED } })) };
    }))).value;
  }
  return n;
}

registerReadyHook(async (dataDir) => { await settleLegacyPendingMatch(dataDir); });
