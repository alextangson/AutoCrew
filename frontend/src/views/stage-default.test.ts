import { describe, it, expect } from "vitest";
import { defaultAdvanceTarget } from "./stage-default";

const t = (status: string, blockedReason?: string) => ({ status, ...(blockedReason ? { blockedReason } : {}) });

describe("defaultAdvanceTarget", () => {
  it("待审的默认是「已过审」,不是表序第一位的「修订」——推进按钮不许默认后退", () => {
    expect(defaultAdvanceTarget("reviewing", [t("revision"), t("approved"), t("draft_ready")])).toBe("approved");
  });

  it("修订可直接过审:默认「已过审」,回待审是手选项", () => {
    expect(defaultAdvanceTarget("revision", [t("reviewing"), t("approved"), t("draft_ready")])).toBe("approved");
  });

  it("已过审的视频稿:待发布被阶段门拦着 → 默认落在能走的「剪辑」", () => {
    expect(
      defaultAdvanceTarget("approved", [t("publish_ready", "视频稿要先过剪辑与封面"), t("reviewing"), t("editing")]),
    ).toBe("editing");
  });

  it("已过审的图文稿:待发布能走 → 默认直通「待发布」", () => {
    expect(
      defaultAdvanceTarget("approved", [t("publish_ready"), t("reviewing"), t("editing", "剪辑阶段只属于视频平台稿件")]),
    ).toBe("publish_ready");
  });

  it("前进方向全被拦(剪辑中成片未审过) → 默认停在被拦的前进站,让原因亮出来,而不是默认退回已过审", () => {
    expect(
      defaultAdvanceTarget("editing", [t("cover_pending", "成片还没审通过"), t("approved")]),
    ).toBe("cover_pending");
  });

  it("没有前进方向(归档态回草稿)与未知状态 → 维持表序第一位;空表回空串", () => {
    expect(defaultAdvanceTarget("archived", [t("draft_ready")])).toBe("draft_ready");
    expect(defaultAdvanceTarget("weird_status", [t("draft_ready")])).toBe("draft_ready");
    expect(defaultAdvanceTarget("reviewing", [])).toBe("");
  });
});

describe("缺证据（P1 §4.4）", () => {
  it("默认推进指向草稿就绪：它与 drafting 同秩，往前一站就是稿成", () => {
    expect(defaultAdvanceTarget("needs_evidence", [{ status: "drafting" }, { status: "draft_ready" }])).toBe(
      "draft_ready",
    );
  });

  it("归档不算推进：有草稿就绪可走时默认不指向归档（推进按钮不该把稿子扔进回收站）", () => {
    expect(
      defaultAdvanceTarget("needs_evidence", [{ status: "drafting" }, { status: "draft_ready" }, { status: "archived" }]),
    ).toBe("draft_ready");
  });
});
