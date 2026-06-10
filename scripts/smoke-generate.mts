/**
 * 手跑冒烟，消耗真实 API 配额，不进测试套件。
 * 用法：DEEPSEEK_API_KEY=... npx tsx scripts/smoke-generate.mts
 *
 * 直接调 generateScript，绕过 MCP 工具层，验证整条生成管线端到端可用。
 */
import { generateScript } from "../src/modules/writing/generate-script.js";

const req = {
  topic: "AI时代普通人最该练的一个技能",
  platform: "douyin" as const,
};

console.log("=== AutoCrew smoke-generate ===");
console.log(`选题：${req.topic}`);
console.log(`平台：${req.platform}`);
console.log("生成中…\n");

try {
  const result = await generateScript(req);

  console.log(`[contentId]   ${result.contentId}`);
  console.log(`[title]       ${result.title}`);
  console.log(`[tokensUsed]  ${result.tokensUsed}`);
  console.log(`[violations]  ${result.violations.length > 0 ? result.violations.join("、") : "（无）"}`);
  console.log(`[hashtags]    ${result.hashtags.join(" ")}`);
  console.log("\n[body]\n");
  console.log(result.body);
  console.log("\n=== 生成完成，稿件已存入 ~/.autocrew/ ===");
} catch (err) {
  console.error("生成失败：", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
