import { describe, expect, it } from "vitest";
import { groupAtoms, type Atom, type Content, type Topic } from "../lib";
import { boardPlatforms } from "./board-model";

function content(id: string, status: string, overrides: Partial<Content> = {}): Content {
  return {
    id,
    title: `稿件 ${id}`,
    body: "正文",
    platform: "douyin",
    status,
    hashtags: [],
    createdAt: "2026-09-22T00:00:00Z",
    updatedAt: "2026-09-22T00:00:00Z",
    ...overrides,
  };
}

const topic: Topic = { id: "topic-1", title: "共同选题", createdAt: "2026-09-22T00:00:00Z" };

function atom(members: Content[]): Atom {
  return { key: `t-${topic.id}`, topic, members };
}




describe("boardPlatforms", () => {
  it("按更新时间、创建时间倒序，再按 id 稳定选当前稿，与输入顺序无关", () => {
    const contents = [
      content("old-update", "draft_ready", { createdAt: "2026-09-23T00:00:00Z" }),
      content("early-created", "draft_ready", { updatedAt: "2026-09-24T00:00:00Z" }),
      content("z", "draft_ready", { updatedAt: "2026-09-24T00:00:00Z", createdAt: "2026-09-23T00:00:00Z" }),
      content("a", "editing", { updatedAt: "2026-09-24T00:00:00Z", createdAt: "2026-09-23T00:00:00Z" }),
    ];
    const groups = boardPlatforms(atom(contents));
    expect(groups[0].current.id).toBe("a");
    expect(groups[0].contents.map((draft) => draft.id)).toEqual(["a", "z", "early-created", "old-update"]);
    expect(boardPlatforms(atom([...contents].reverse()))).toEqual(groups);
  });

  it("坏日期排在有效日期后，坏日期之间也有确定次序", () => {
    const groups = boardPlatforms(atom([
      content("invalid-z", "draft_ready", { updatedAt: "bad", createdAt: "bad" }),
      content("valid", "editing"),
      content("invalid-a", "draft_ready", { updatedAt: "bad", createdAt: "bad" }),
    ]));
    expect(groups[0].contents.map((draft) => draft.id)).toEqual(["valid", "invalid-a", "invalid-z"]);
  });

  it("平台顺序按目录固定，未知平台按 id 排，所有稿件均保留", () => {
    const contents = [
      content("z", "draft_ready", { platform: "zzz" }),
      content("dy", "draft_ready", { platform: "douyin" }),
      content("a", "draft_ready", { platform: "aaa" }),
      content("wx", "draft_ready", { platform: "wechat_mp" }),
    ];
    const groups = boardPlatforms(atom(contents));
    expect(groups.map((group) => group.platform)).toEqual(["wechat_mp", "douyin", "aaa", "zzz"]);
    expect(groups.flatMap((group) => group.contents)).toHaveLength(contents.length);
    expect(boardPlatforms(atom([...contents].reverse()))).toEqual(groups);
    expect(boardPlatforms(atom([]))).toEqual([]);
  });
});

describe("groupAtoms 以真实主题标识归组", () => {
  it("topicId 相同且主题记录缺失，仍只生成一个主题组", () => {
    const contents = [
      content("dy", "draft_ready", { topicId: "missing" }),
      content("wx", "editing", { topicId: "missing", platform: "wechat_mp" }),
    ];
    expect(groupAtoms([], contents)).toEqual([{ key: "t-missing", topic: null, members: contents }]);
  });

  it("不同主题标识或无主题标识，即使标题相同也不模糊合并", () => {
    const contents = [
      content("one", "draft_ready", { title: "同名", topicId: "topic-a" }),
      content("two", "draft_ready", { title: "同名", topicId: "topic-b" }),
      content("solo-1", "draft_ready", { title: "同名" }),
      content("solo-2", "draft_ready", { title: "同名" }),
    ];
    expect(groupAtoms([], contents).map((group) => group.key)).toEqual(["t-topic-a", "t-topic-b", "c-solo-1", "c-solo-2"]);
  });
});


