/**
 * 测试与内部种子用：记一条规则并以工作台决定的方式批准生效。
 * 只给测试夹具用——产品里模型可达的入口不许调用它（批准只走 desktop/rule-approval）。
 */
import { randomUUID } from "node:crypto";
import { addWritingRule, decideWritingRule } from "./writing-rules.js";
import type { CreatorProfile, WritingRule } from "./creator-profile.js";

export async function addApprovedRuleForTest(
  rule: Omit<WritingRule, "createdAt" | "id" | "revision" | "status" | "disabled" | "promotes">,
  dataDir: string,
): Promise<CreatorProfile> {
  const added = await addWritingRule(rule, dataDir);
  const r = added.writingRules.find((x) => x.rule === rule.rule.trim() && (x.scope ?? "voice_core") === (rule.scope ?? "voice_core"));
  if (!r?.id || r.revision === undefined) throw new Error("fixture rule not created");
  return decideWritingRule({ ruleId: r.id, revision: r.revision, decision: "active", eventId: `fixture-${randomUUID()}` }, dataDir);
}
