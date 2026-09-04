/**
 * 平台改写（`adaptPlatformDraft`）——纯函数。
 *
 * 这里锁的是一条**跨模块的一致性**：P1 §4.4 之后，口播格式硬门会把带 `[画面]`/`[口播]`
 * 这类标注的稿整篇打回。改写适配器从前给抖音注入的正是这一族标注——两边不同步，
 * 改写出来的稿就是一份必定过不了自家门禁的稿。
 */
import { describe, expect, it } from "vitest";
import { adaptPlatformDraft } from "./platform-rewrite.js";
import { findFormatMarkers } from "./format-gate.js";

const DRAFT = {
  title: "AI 编程助手到底值不值",
  body: ["厂商说能提效，我实测了两周。", "先说结论：分任务类型。", "重构类几乎没用，样板代码确实快。"].join("\n\n"),
  tags: ["AI编程", "实测"],
};

function adapt(platform: string) {
  const out = adaptPlatformDraft({ targetPlatform: platform, title: DRAFT.title, body: DRAFT.body, tags: DRAFT.tags });
  if (!out.ok) throw new Error(`adapt failed: ${JSON.stringify(out)}`);
  return out;
}

describe("adaptPlatformDraft — 抖音", () => {
  it("不再注入 [3秒开头]/[口播]/[字幕重点]：格式硬门会把它们整篇打回", () => {
    const out = adapt("douyin");
    for (const marker of ["[3秒开头]", "[口播]", "[字幕重点]", "[互动引导]"]) {
      expect(out.body).not.toContain(marker);
    }
  });

  it("改写结果自己过得了口播格式硬门（两侧同一把尺）", () => {
    const out = adapt("douyin");
    const hits = findFormatMarkers({ title: out.title!, hook: "", body: out.body!, cta: "" });
    expect(hits).toEqual([]);
  });

  it("结构照旧：钩子仍是第一段，互动引导仍在结尾", () => {
    const out = adapt("douyin");
    expect(out.body!.startsWith("厂商说能提效，我实测了两周。")).toBe(true);
    expect(out.body).toContain("你最卡的是哪一步？评论区告诉我。");
    expect(out.notes).toContain("纯口播正文，不写画面/字幕条/镜头标注。");
  });
});

describe("adaptPlatformDraft — 其他平台不受这一刀影响", () => {
  it("小红书仍是短段落 + 标签行", () => {
    const out = adapt("xiaohongshu");
    expect(out.platform).toBe("xiaohongshu");
    expect(out.body).toContain("#AI编程");
  });

  it("公众号照旧", () => {
    const out = adapt("wechat_mp");
    expect(out.platform).toBe("wechat_mp");
    expect(out.body).toContain("厂商说能提效");
  });
});
