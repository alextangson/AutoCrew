/**
 * 状态文案与工作台归属（纯数据）。看板列归属在服务端 explain()（本体 spec §2.6），
 * 前端旧的状态→列表已删；这里只锁住状态人话名、工作台落点与代表稿的推进顺序。
 */
import { describe, expect, it } from "vitest";
import { atomRep, VARIANT_STATUS, workspaceForStatus, type Content } from "./lib";

describe("needs_evidence（P1 §4.4）在看板上有位置", () => {
  it("有人话状态名，不会在卡片上露出英文枚举", () => {
    expect(VARIANT_STATUS["needs_evidence"]).toBe("缺证据");
  });

  it("打开它进文案台（不是剪辑/封面/发布台）", () => {
    expect(workspaceForStatus("needs_evidence")).toBe("draft");
  });
});

describe("状态人话名与推进顺序（看板列以服务端 explain 为准，前端不再有状态→列表）", () => {
  it("每个状态都有人话名", () => {
    for (const s of ["topic_saved", "drafting", "needs_evidence", "draft_ready", "revision", "reviewing", "approved", "editing", "cover_pending", "publish_ready", "publishing", "published"]) {
      expect(VARIANT_STATUS[s]).toBeTruthy();
    }
  });

  it("同一选题下几篇稿，代表稿取走得最远的那篇", () => {
    const m = (id: string, status: string) => ({ id, status, title: id }) as unknown as Content;
    expect(atomRep({ key: "t", topic: null, members: [m("a", "draft_ready"), m("b", "editing"), m("c", "reviewing")] })?.id).toBe("b");
  });
});
