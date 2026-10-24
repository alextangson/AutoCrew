/**
 * 英文版在看板 / 我的内容 / 登记回执里的「还差什么」（全媒体 verifier P2）：英文版不走中文登记，
 * 不要 3:4 + 4:3 封面对，要的是 16:9 缩略图和创始人批过的英文发布包。成片审过 + 发布包批过 = 待发布。
 * 只改英文版的说法，中文视频的推导一字不动。
 */
import type { Content } from "../../storage/local-store.js";
import { isFounderAsk, MISSING } from "../production/derive.js";
import { STAGE_STATUS, type Explanation } from "../production/explain.js";
import { enPackageState } from "./package.js";

export const EN_MISSING = { thumbnail: "英文缩略图(16:9)", pkg: "英文发布包待你批" } as const;
const ZH_COVER: ReadonlySet<string> = new Set([MISSING.cover34, MISSING.cover43, MISSING.coverPick]);

function reasonOf(missing: string[], cutApproved: boolean): string {
  const ask = missing.find(isFounderAsk);
  if (ask) return `${ask}，等 AI 交新版`;
  if (missing.includes(MISSING.cutReview)) return "有英文成片待你审";
  if (cutApproved) return `英文成片审过了，还差：${missing.join("、")}`;
  return missing.length ? `剪辑中，还差：${missing.join("、")}` : "剪辑中";
}

export async function withEnNeeds(content: Pick<Content, "id" | "derivedFrom">, exp: Explanation, dataDir: string): Promise<Explanation> {
  if (content.derivedFrom?.kind !== "en_edition" || exp.phase !== "production" || exp.stage === "已发布") return exp;
  const base = exp.missing.filter((m) => !ZH_COVER.has(m) && !(isFounderAsk(m) && m.includes("封面")));
  const s = await enPackageState(content.id, dataDir).catch((e: unknown) => ({ code: "unreadable", error: e instanceof Error ? e.message : String(e) }));
  if ("error" in s) return { ...exp, missing: base, alerts: [...exp.alerts, `英文发布包读不出来：${s.error}`], reason: reasonOf(base, false) };
  if (s.cut && s.file.approval && s.approval.ok) {
    return { ...exp, column: "待发布", stage: "待发布", status: STAGE_STATUS["待发布"], missing: [], publishable: true, reason: "英文成片和英文发布包都批过了，可以发" };
  }
  const missing = [...base, ...(s.thumbnail ? [] : [EN_MISSING.thumbnail]), ...(s.cut ? [EN_MISSING.pkg] : [])];
  return { ...exp, column: "剪辑中", stage: "剪辑中", status: STAGE_STATUS["剪辑中"], missing, publishable: false, reason: reasonOf(missing, Boolean(s.cut)) };
}
