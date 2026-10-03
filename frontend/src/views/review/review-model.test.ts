/** 「等你拍板」分行：稿子合成一行，但挡着成片 / 封面审阅的稿子单独一行（说明不被合并吞掉） */
import { describe, expect, it } from "vitest";
import { groupRows, type InboxItem } from "./review-model";

const draft = (id: string, detail: Record<string, unknown> = {}, summary = "稿子写好了，过一眼"): InboxItem => ({
  item_id: `draft:${id}`, gen: "g", type: "draft", content_id: id, title: `稿${id}`, summary, waiting: null, agent_waiting: false, since: "2026-10-03T00:00:00.000Z", rank: 3, actions: [], detail,
});

describe("groupRows 稿子分行", () => {
  it("普通稿子合成一行；waiting_behind 的单独成行并保留它自己的说明", () => {
    const behind = { ...draft("c", { waiting_behind: ["cut_review"] }, "稿子写好了，过一眼（成片剪好了，认稿后才能审）"), rank: 1 };
    const rows = groupRows([draft("a"), draft("b"), behind]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: "draft:c", title: "稿子写好了，过一眼（成片剪好了，认稿后才能审）" });
    expect(rows[1]).toMatchObject({ key: "group:draft", title: "2 篇稿子写好了，过一眼" });
  });
});
