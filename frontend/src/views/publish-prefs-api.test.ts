/** Codex 审查 [P2]：复制失败后改了指令，「打开 Codex」必须重存，不能沿用旧编号 */
import { describe, expect, it } from "vitest";
import { skipResave } from "./publish-prefs-api";

describe("skipResave", () => {
  const saved = "发布这条视频\n指令编号：ins-20260929120000-abcdef";
  it("只有复制失败且文本就是已存那份时才跳过重存", () => {
    expect(skipResave(true, saved, saved)).toBe(true);
  });
  it("复制失败后改过文字、改过平台勾选（文本重写、编号行丢失）、或还没存过 → 必须重存", () => {
    expect(skipResave(true, `${saved}\n我又加了一句`, saved)).toBe(false);
    expect(skipResave(true, "发布这条视频（平台：抖音、B站）", saved)).toBe(false);
    expect(skipResave(true, saved, null)).toBe(false);
    expect(skipResave(false, saved, saved)).toBe(false);
  });
});
