import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, groupAtoms, type Atom, type Content, type Topic } from "../lib";
import { boardColumns, boardMoveTarget, boardPlatforms, type BoardTopic } from "./board-model";

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

function inColumn(columns: BoardTopic[][], key: string): BoardTopic[] {
  return columns[BOARD_COLUMNS.findIndex((column) => column.key === key)];
}

describe("boardColumns", () => {
  it("同选题的多平台稿只显示一张主题卡，按最早未完成平台落列", () => {
    const writing = content("douyin-1", "draft_ready", { topicId: topic.id });
    const editing = content("wechat-1", "editing", { topicId: topic.id, platform: "wechat_mp" });
    const published = content("reddit-1", "published", { topicId: topic.id, platform: "reddit" });
    const columns = boardColumns(groupAtoms([topic], [writing, editing, published]));
    const cards = inColumn(columns, "writing");

    expect(columns.flat()).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ atomKey: "t-topic-1", topic, title: topic.title, columnIndex: 1 });
    expect(cards[0].platforms.map((platform) => platform.current.id)).toEqual(["wechat-1", "douyin-1", "reddit-1"]);
    expect(cards[0].members).toEqual([writing, editing, published]);
    expect(inColumn(columns, "producing")).toEqual([]);
    expect(inColumn(columns, "published")).toEqual([]);
  });

  it.each([
    ["reviewing", "editing", "review"],
    ["editing", "publish_ready", "producing"],
    ["publish_ready", "published", "ready"],
    ["published", "published", "published"],
  ])("平台状态 %s 和 %s 汇总到 %s", (left, right, column) => {
    const columns = boardColumns([atom([
      content("left", left),
      content("right", right, { platform: "wechat_mp" }),
    ])]);
    expect(inColumn(columns, column)).toHaveLength(1);
    expect(columns.flat()).toHaveLength(1);
  });

  it("同平台历史稿全部可访问，但不重复计数，也不拖住当前稿进度", () => {
    const old = content("old", "draft_ready");
    const current = content("current", "published", { updatedAt: "2026-09-22T02:00:00Z" });
    const columns = boardColumns([atom([old, current])]);
    const [card] = inColumn(columns, "published");

    expect(columns.flat()).toHaveLength(1);
    expect(card.platforms).toHaveLength(1);
    expect(card.platforms[0].current).toBe(current);
    expect(card.platforms[0].contents).toEqual([current, old]);
    expect(card.members).toEqual([old, current]);
  });

  it("新版本回到在写时，以新版本为准，不借旧已发布稿冒充完成", () => {
    const columns = boardColumns([atom([
      content("old-published", "published"),
      content("new-draft", "draft_ready", { updatedAt: "2026-09-22T02:00:00Z" }),
    ])]);
    expect(inColumn(columns, "writing")[0].platforms[0].current.id).toBe("new-draft");
    expect(inColumn(columns, "published")).toEqual([]);
  });

  it.each(["future_status", "toString"])("无选题单稿的未知状态 %s 回落在写", (status) => {
    const solo = content("solo", status);
    const columns = boardColumns(groupAtoms([], [solo]));
    const [card] = inColumn(columns, "writing");

    expect(card).toMatchObject({ atomKey: "c-solo", topic: null, title: solo.title, columnIndex: 1 });
    expect(card.platforms[0].current).toBe(solo);
    expect(columns.flat()).toHaveLength(1);
  });

  it("纯灵感在首列保留一张主题卡，空数据仍有完整列结构", () => {
    const columns = boardColumns(groupAtoms([topic], []));
    expect(inColumn(columns, "idea")).toEqual([{
      atomKey: "t-topic-1", topic, title: topic.title, platforms: [], members: [], columnIndex: 0,
    }]);
    expect(columns.flat()).toHaveLength(1);
    expect(boardColumns([])).toEqual(BOARD_COLUMNS.map(() => []));
  });

  it("主题记录缺失时用最近修改稿的标题，仍保留原主题分组键", () => {
    const columns = boardColumns(groupAtoms([], [
      content("old", "draft_ready", { topicId: "missing-topic", title: "旧标题" }),
      content("new", "editing", { topicId: "missing-topic", title: "新标题", updatedAt: "2026-09-22T03:00:00Z" }),
    ]));
    expect(columns.flat()).toHaveLength(1);
    expect(columns.flat()[0]).toMatchObject({ atomKey: "t-missing-topic", topic: null, title: "新标题" });
  });

  it("分组和排序不修改原分组、稿件、主题或成员顺序", () => {
    const old = content("old", "draft_ready");
    const current = content("current", "editing", { updatedAt: "2026-09-22T01:00:00Z" });
    const input = [atom([old, current])];
    const before = structuredClone(input);
    Object.freeze(old);
    Object.freeze(current);
    Object.freeze(input[0].topic);
    Object.freeze(input[0].members);
    Object.freeze(input[0]);
    Object.freeze(input);

    const columns = boardColumns(input);
    boardPlatforms(input[0]);
    boardMoveTarget(current, "review");

    expect(input).toEqual(before);
    expect(inColumn(columns, "producing")[0].platforms[0].current).toBe(current);
    expect(inColumn(columns, "producing")[0].topic).toBe(topic);
  });
});

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
    expect(boardColumns(groupAtoms([], contents)).flat()).toHaveLength(4);
  });
});

describe("boardMoveTarget", () => {
  it.each(BOARD_COLUMNS.flatMap((column) => column.statuses.map((status) => [status, column.key])))
    ("%s 留在 %s 列时保持原细分状态", (status, columnKey) => {
      expect(boardMoveTarget({ status }, columnKey)).toBeNull();
    });

  it.each([
    ["editing", "writing", "draft_ready"],
    ["draft_ready", "review", "reviewing"],
    ["reviewing", "producing", "approved"],
    ["editing", "ready", "publish_ready"],
    ["publish_ready", "published", "published"],
  ])("%s 移入 %s 列使用代表状态 %s", (status, columnKey, target) => {
    expect(boardMoveTarget({ status }, columnKey)).toBe(target);
  });

  it("未知状态也按在写列处理，不在同列落下时重置状态", () => {
    expect(boardMoveTarget({ status: "future_status" }, "writing")).toBeNull();
    expect(boardMoveTarget({ status: "future_status" }, "review")).toBe("reviewing");
  });

  it.each(["idea", "unknown", "", "toString"])("%s 不是可流转的落点", (columnKey) => {
    expect(boardMoveTarget({ status: "editing" }, columnKey)).toBeNull();
  });
});
