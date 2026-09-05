import { describe, it, expect } from "vitest";
import { findFormatMarkers, formatFormatGateFeedback } from "./format-gate.js";
import type { ScriptFields } from "./number-gate.js";

const EMPTY: ScriptFields = { title: "", hook: "", body: "", cta: "" };

function body(text: string): ScriptFields {
  return { ...EMPTY, body: text };
}

function markers(text: string): string[] {
  return findFormatMarkers(body(text)).map((h) => h.marker);
}

describe("findFormatMarkers", () => {
  it("方括号舞台指令：画面 / 字幕 / 字幕条 / 口播 / 切 / 停顿 / 强调 / 慢", () => {
    for (const marker of [
      "[画面]", "【画面】", "[字幕]", "[字幕条]", "[口播]", "[切黑]", "[切近景]",
      "[停顿]", "[强调]", "[慢]", "[镜头:推近]", "[音效]", "[空镜]",
    ]) {
      expect(markers(`开场${marker}然后讲重点`), marker).toEqual([marker]);
    }
  });

  it("括号变体：（画面：…）/ (画面: …) / 【画面：…】", () => {
    expect(markers("（画面：桌面截图）配合讲解")).toEqual(["（画面：桌面截图）"]);
    expect(markers("(画面: desktop shot) 配合讲解")).toEqual(["(画面: desktop shot)"]);
    expect(markers("【画面：终端滚动】")).toEqual(["【画面：终端滚动】"]);
  });

  it("裸词：B-roll / B roll / 镜头一二三 / 分镜 2", () => {
    expect(markers("这里插一段 B-roll")).toEqual(["B-roll"]);
    expect(markers("这里插一段 b roll")).toEqual(["b roll"]);
    expect(markers("镜头一：手写笔记；镜头二：屏幕")).toEqual(["镜头一", "镜头二"]);
    expect(markers("镜头 3 切到白板")).toEqual(["镜头 3"]);
    expect(markers("分镜 2 是重点")).toEqual(["分镜 2"]);
  });

  it("四个字段都扫", () => {
    const hits = findFormatMarkers({
      title: "[画面] 三个坑",
      hook: "【字幕条】开场就说结论",
      body: "（画面：终端）跑一遍",
      cta: "B-roll 收尾",
    });
    expect(hits.map((h) => h.field)).toEqual(["title", "hook", "body", "cta"]);
    expect(hits).toHaveLength(4);
  });

  it("不误伤正常行文与其他标记", () => {
    expect(markers("这个画面感很强，读起来像镜头语言")).toEqual([]);
    expect(markers("[IMAGE: 数据对比图]")).toEqual([]);
    expect(markers("留存 [未证实] 45%")).toEqual([]);
    expect(markers("（切实可行的三步做法）")).toEqual([]);
    expect(markers("（快手和抖音的差别）")).toEqual([]);
  });

  it("同一个位置不重复计数", () => {
    expect(markers("[B-roll: 城市空镜]")).toEqual(["[B-roll: 城市空镜]"]);
  });

  it("超长标记截断展示", () => {
    const long = `[画面：${"细节".repeat(40)}]`;
    expect(markers(long)[0].endsWith("…")).toBe(true);
    expect(markers(long)[0].length).toBeLessThanOrEqual(41);
  });
});

describe("formatFormatGateFeedback", () => {
  it("给出命中位置与改法", () => {
    const msg = formatFormatGateFeedback(findFormatMarkers(body("开场[画面]讲三个坑")));
    expect(msg).toContain("口播格式硬门未通过");
    expect(msg).toContain("「[画面]」");
    expect(msg).toContain("正文");
    expect(msg).toContain("submit_script");
  });

  it("没命中返回空串", () => {
    expect(formatFormatGateFeedback([])).toBe("");
  });
});
