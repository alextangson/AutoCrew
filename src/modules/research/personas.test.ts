import { describe, expect, it } from "vitest";
import type { CreatorProfile } from "../profile/creator-profile.js";
import { DEFAULT_PERSONAS, renderPersonas } from "./personas.js";

const profile = (over: Partial<CreatorProfile>) => over as CreatorProfile;

describe("受众来自任务和档案，不再固定为AI行业", () => {
  it("未设画像明确未知，不发明人群、年龄或行业焦虑", () => {
    const result = renderPersonas(null);
    expect(result).toContain("账号受众未设置");
    expect(result).toContain("并非三个必须同时服务的画像");
    expect(result).not.toContain("ChatGPT");
    expect(result).not.toContain("25–40");
    expect(Object.values(DEFAULT_PERSONAS).map(value => value.who).join("\n")).not.toContain("AI");
  });

  it("已确认的非AI受众和长期目标进入上下文，本次要求优先", () => {
    const result = renderPersonas(profile({
      industry: "社区园艺",
      audiencePersona: { core: { name: "城市新手种植者", coreAnxiety: "不知道何时浇水" }, calibratedAt: "2026-09-22" },
      goal: { statement: "帮助邻居把阳台植物养活", setAt: "2026-09-22" },
    }));
    expect(result).toContain("已确认的账号受众：核心受众=城市新手种植者");
    expect(result).toContain("帮助邻居把阳台植物养活");
    expect(result).toContain("与本次目标冲突时以本次任务为准");
    expect(result).not.toContain("vibecoder");
    expect(result).not.toContain("技术 VP");
  });

  it("提案态画像可参考但不能冒充用户已确认", () => {
    const result = renderPersonas(profile({ audiencePersona: { core: { name: "新手家长" } } }));
    expect(result).toContain("待确认的账号画像提案");
    expect(result).toContain("工作假设");
    expect(result).not.toContain("已确认的账号受众：");
  });
});
