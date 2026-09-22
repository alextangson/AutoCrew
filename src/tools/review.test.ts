import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeReview } from "./review.js";
import { getContent, saveContent } from "../storage/local-store.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-mechanical-review-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function review(params: Record<string, unknown>) {
  return executeReview({ ...params, _dataDir: dataDir });
}

async function addCustomWord(word: string) {
  await fs.mkdir(path.join(dataDir, "sensitive-words"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "sensitive-words", "custom.txt"), `${word}\n`);
}

describe("legacy review remains mechanical and read-only", () => {
  it("自然稿不会因没有数字、震惊、问句或 CTA 而输给套路稿", async () => {
    const natural = await review({ action: "quality_score", text: "昨天下午，我把返工记录摊在桌上。写得快了，回头确认的活依然不少。" });
    const formulaic = await review({ action: "quality_score", text: "震惊！居然提高了 30%？真相是每天节省 3 个小时。赶紧点赞收藏关注！" });
    expect(natural).toMatchObject({ quality_status: "mechanical_checks_only", semantic_review: false });
    if (!("qualityScore" in natural) || !("qualityScore" in formulaic)) throw new Error("missing score");
    expect(natural.qualityScore.total).toBeGreaterThanOrEqual(formulaic.qualityScore.total);
    expect(natural.qualityScore).toMatchObject({ metric: "readability_only", hookStrength: null, ctaClarity: null, infoDensity: null });
    expect(natural.qualityScore.notes.join(" ")).not.toMatch(/缺少 CTA|引导互动|提问式|数据切入/);
  });

  for (const hasHit of [false, true]) {
    it(`读取 full_review 不会${hasHit ? "因词表命中而退回" : "因机械检查通过而批准"}稿件`, async () => {
      if (hasHit) await addCustomWord("返工记录");
      const content = await saveContent({ title: "昨天的记录", body: "我们整理了返工记录。", platform: "douyin", status: "reviewing" }, dataDir);
      const before = await getContent(content.id, dataDir);
      const result = await review({ action: "full_review", content_id: content.id });
      expect(result).toMatchObject({ passed: !hasHit, quality_status: "mechanical_checks_only", semantic_review: false });
      expect(await getContent(content.id, dataDir)).toEqual(before);
      expect("summary" in result && result.summary).toContain("尚未进行");
      expect("summary" in result && result.summary).not.toMatch(/审核通过|质量通过|AI 痕迹:.*无/);
    });
  }

  it("空白变化和可选表达建议不被误判为 AI 痕迹或审稿失败", async () => {
    const result = await review({ action: "full_review", text: "  我们把两个环节形成闭环。  \r\n我们保留复核记录。\r\n我们继续复盘。  " });
    expect(result).toMatchObject({
      passed: true,
      semantic_review: false,
      aiCheck: { assessed: false, hasAiTraces: null, changeCount: 0 },
      formatting: { changeCount: 1 },
    });
    expect("suggestions" in result && result.suggestions.length).toBeGreaterThan(0);
    expect("summary" in result && result.summary).toContain("未更改稿件状态");
  });

  it("长句和长段给阅读建议，不把格式分当语义质量门", async () => {
    const result = await review({ action: "full_review", text: "这段解释用于完整交代背景，".repeat(40) });
    expect(result).toMatchObject({ passed: true, quality_status: "mechanical_checks_only", semantic_review: false });
    if (!("qualityScore" in result)) throw new Error("missing score");
    expect(result.qualityScore.notes.join(" ")).toMatch(/平均句长|超过 300 字/);
    expect(result.qualityScore.total).toBeLessThan(100);
  });

  it("auto_fix 仅清空白，不替换敏感词或主语，也不把标题复制进正文", async () => {
    await addCustomWord("闭环");
    const body = "  我们记录问题。  \r\n我们形成闭环。\r\n我们继续复盘。  ";
    const content = await saveContent({ title: "保留原来的标题", body, platform: "douyin", status: "reviewing" }, dataDir);
    const result = await review({ action: "auto_fix", content_id: content.id });
    expect(result).toMatchObject({
      quality_status: "mechanical_checks_only",
      semantic_review: false,
      sensitiveWordsFixed: 0,
      aiFixesApplied: 0,
      formatFixesApplied: 1,
      saved: true,
      unfixedSensitiveWords: ["闭环"],
    });
    const saved = await getContent(content.id, dataDir);
    expect(saved?.body).toBe("我们记录问题。\n我们形成闭环。\n我们继续复盘。");
    expect(saved?.title).toBe(content.title);
    expect(saved?.status).toBe("reviewing");
    expect("summary" in result && result.summary).toContain("尚未进行语义审稿");
  });

  it("auto_fix 也不自动应用平台敏感词的替换建议", async () => {
    const result = await review({ action: "auto_fix", text: "请关注公众号查看文章。", platform: "wechat" });
    expect(result).toMatchObject({
      autoFixedText: "请关注公众号查看文章。",
      sensitiveWordsFixed: 0,
      aiFixesApplied: 0,
      sensitiveWords: { hits: [{ word: "关注公众号", suggestion: "关注我们" }] },
    });
  });

  it("scan_only 同样披露检查范围并保留实际词表扫描", async () => {
    await addCustomWord("待核对词");
    const result = await review({ action: "scan_only", text: "这里包含待核对词。" });
    expect(result).toMatchObject({ semantic_review: false, quality_status: "mechanical_checks_only", sensitiveWords: { hitCount: 1 } });
  });
});
