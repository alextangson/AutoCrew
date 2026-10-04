/**
 * 写正文的调用方清点（选题会卡口第六轮）：生产代码里每一处调用
 * saveContent / updateContent / updateContentIfDraftMatches / updateContentChecked /
 * revertToVersion / createPlatformVariant，都必须要么显式带上来源（调用文本里出现 provenance），
 * 要么登记在下面的白名单里并写明为什么不写正文（或只写占位空正文）。
 * 以后新加一个写口忘了带来源，这条测试就会红——不靠记性。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WRITERS = /(?<![\w.])(saveContent|updateContent|updateContentIfDraftMatches|updateContentChecked|revertToVersion|createPlatformVariant)\(/g;

/** key = 文件#函数名#该文件里第几处同名调用（从 1 起）；value = 不带来源也安全的理由 */
const NO_BODY_WRITES: Record<string, { reason: string; placeholderBody?: true }> = {
  "src/desktop/board-actions.ts#saveContent#1": { reason: "看板「开始写」建空正文的写稿中占位", placeholderBody: true },
  "src/desktop/board-actions.ts#updateContent#1": { reason: "只改 manualPublications（我发了）" },
  "src/desktop/board-actions.ts#updateContent#2": { reason: "只改 manualPublications（撤销我发了）" },
  "src/desktop/board-actions.ts#updateContent#3": { reason: "只改 manualPublications" },
  "src/desktop/orphan-reconcile.ts#updateContent#1": { reason: "只改标题前缀与 lastError（中断标记）" },
  "src/modules/flywheel/work-binding.ts#saveContent#1": { reason: "历史作品登记，空正文", placeholderBody: true },
  "src/modules/video/handoff/register-commit.ts#updateContent#1": { reason: "只写成片登记与认领" },
  "src/modules/video/handoff/register-commit.ts#updateContent#2": { reason: "只写成片登记与认领（patch 只含 video / claim）" },
  "src/modules/video/video-done.ts#updateContent#1": { reason: "只写成片戳 videoDone / videoReadyAt" },
  "src/modules/writing/generate-script.ts#saveContent#1": { reason: "生成任务的空正文占位（准入已在 admitWritingJob 判过）", placeholderBody: true },
  "src/modules/writing/generate-script.ts#updateContent#1": { reason: "只改标题前缀与版本注记（调研中 / 开始写）" },
  "src/modules/writing/generate-script.ts#updateContent#4": { reason: "只写归因与证据账本元数据（contentAttribution）" },
  "src/modules/writing/generate-script.ts#updateContent#5": { reason: "只改标题前缀与 lastError（写崩标记）" },
  "src/modules/writing/generate-script.ts#updateContent#6": { reason: "重写开跑：只改标题前缀、清 lastError / 拦截痕" },
  "src/storage/claims.ts#updateContent#1": { reason: "只写认领令牌与交接记录" },
  "src/storage/claims.ts#updateContent#5": { reason: "只写认领令牌" },
  "src/storage/local-store.ts#updateContent#3": { reason: "只写采纳判定 adoption" },
  "src/tools/editorial.ts#updateContentIfDraftMatches#1": { reason: "只写修改反馈（writingFeedback），第二个参数是期望正文不是写入" },
  "src/tools/host-review.ts#updateContentIfDraftMatches#1": { reason: "只写系列比对结论" },
  "src/tools/pre-publish.ts#updateContentIfDraftMatches#1": { reason: "只写发布包 videoKit" },
  "src/tools/writer-prepare.ts#updateContent#1": { reason: "只写包与写作请求元数据（writtenBy / genRequest / pack）" },
  "src/tools/writer-prepare.ts#updateContent#2": { reason: "只写备料归因元数据" },
  "src/tools/writer-review.ts#updateContent#2": { reason: "只写审稿收尾状态（settledPatch）" },
  "src/tools/writer-review.ts#updateContentIfDraftMatches#1": { reason: "第二个参数是期望正文（核对用），写入的是审稿收尾状态" },
  "src/tools/writer-revision.ts#updateContentIfDraftMatches#1": { reason: "只给导入稿补选题与平台关联" },
};

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    if (fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    else if (p.endsWith(".ts") && !/\.test\.ts$|test-helper|testkit|test-fixtures/.test(p)) out.push(p);
  };
  walk("src");
  out.push("index.ts");
  return out;
}

function callsIn(file: string): Array<{ key: string; text: string }> {
  const src = fs.readFileSync(file, "utf8");
  const seen = new Map<string, number>();
  const calls: Array<{ key: string; text: string }> = [];
  for (const m of src.matchAll(WRITERS)) {
    if (/(function|async function)\s+$/.test(src.slice(Math.max(0, m.index! - 20), m.index))) continue; // 定义本身
    let i = m.index! + m[0].length, depth = 1;
    while (depth && i < src.length) { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; i++; }
    const n = (seen.get(m[1]) ?? 0) + 1;
    seen.set(m[1], n);
    calls.push({ key: `${file.split(path.sep).join("/")}#${m[1]}#${n}`, text: src.slice(m.index, i) });
  }
  return calls;
}

/**
 * 一眼可证不碰正文的写：更新内容是对象字面量，里面没有 body 键也没有展开（...）。
 * 其余（变量、补丁函数、展开）一律要带来源或进白名单。
 */
function metadataOnly(call: string): boolean {
  const literal = /^\w+\(\s*(?:[^,{]+,\s*)?(\{[\s\S]*\})\s*,\s*[\w.?()| ]+\)$/.exec(call.replace(/\s+/g, " ").trim());
  if (!literal) return false;
  return !/\bbody\b/.test(literal[1]) && !/\.\.\./.test(literal[1]);
}

describe("写正文的调用方都显式带来源", () => {
  const all = productionFiles().flatMap(callsIn);

  it("每一处要么带 provenance，要么登记在白名单里", () => {
    const missing = all.filter((c) => !/provenance/i.test(c.text) && !metadataOnly(c.text) && !NO_BODY_WRITES[c.key]).map((c) => `${c.key}: ${c.text.slice(0, 80)}`);
    expect(missing, `这些写口没带来源（_provenance / provenance），也不在白名单：\n${missing.join("\n")}`).toEqual([]);
  });

  it("白名单里标了占位的，调用里正文确实是空串；白名单不留已删除的条目", () => {
    const byKey = new Map(all.map((c) => [c.key, c.text]));
    for (const [key, entry] of Object.entries(NO_BODY_WRITES)) {
      expect(byKey.has(key), `白名单条目已不存在：${key}`).toBe(true);
      if (entry.placeholderBody) expect(byKey.get(key), key).toMatch(/body:\s*""/);
    }
  });
});
