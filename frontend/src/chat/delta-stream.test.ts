/**
 * 流式 delta 状态机（对话控制面设计 §Phase 3）：SSE 是广播，
 * 「这一帧该不该进气泡」的每条规则都在这里断死——异 turn 丢弃、迟到帧丢弃、
 * reset 清空、done 只是等响应，事实源永远是 invoke 返回。
 */
import { describe, it, expect } from "vitest";
import {
  EMPTY_STREAM,
  applyDelta,
  clearStream,
  parseDeltaFrame,
  startStream,
  type DeltaFrame,
  type DeltaStream,
} from "./delta-stream";

/** 按服务端口径喂一串帧（seq 单调递增，与 chatTurnHandler 的计数同构） */
function feed(state: DeltaStream, turnId: string, frames: Array<Omit<DeltaFrame, "turnId" | "seq">>, from = 0): DeltaStream {
  return frames.reduce((s, f, i) => applyDelta(s, { turnId, seq: from + i, ...f }), state);
}

describe("delta 累积", () => {
  it("逐段增量拼成完整正文", () => {
    const s = feed(startStream("t1"), "t1", [
      { ev: "reset" },
      { ev: "delta", text: "选题" },
      { ev: "delta", text: "我给你" },
      { ev: "delta", text: "拆成三条" },
    ]);
    expect(s.text).toBe("选题我给你拆成三条");
    expect(s.done).toBe(false);
  });

  it("done 只标记「等响应」，不动已累积的正文", () => {
    const s = feed(startStream("t1"), "t1", [{ ev: "delta", text: "写完了" }, { ev: "done" }]);
    expect(s).toMatchObject({ text: "写完了", done: true });
  });

  it("没开轮（turnId 为 null）时任何帧都不收", () => {
    const s = applyDelta(EMPTY_STREAM, { turnId: "t1", seq: 0, ev: "delta", text: "野帧" });
    expect(s).toBe(EMPTY_STREAM); // 同一引用：调用方可据此免掉重渲染
  });
});

describe("reset 语义（失败 attempt / 工具往返的新一轮）", () => {
  it("reset 清空当前累积，之后的 delta 属于新 attempt", () => {
    const first = feed(startStream("t1"), "t1", [{ ev: "reset" }, { ev: "delta", text: "半句话就断了" }]);
    const second = feed(first, "t1", [{ ev: "reset" }, { ev: "delta", text: "重来一遍的完整回答" }], 2);
    expect(second.text).toBe("重来一遍的完整回答"); // 失败 attempt 的字不许留在屏幕上
  });

  it("reset 把 done 也退回去（上一轮说完了不等于整轮说完了）", () => {
    const s = feed(startStream("t1"), "t1", [{ ev: "delta", text: "先说一句" }, { ev: "done" }, { ev: "reset" }]);
    expect(s).toMatchObject({ text: "", done: false });
  });
});

describe("turnId 过滤与 seq 容错", () => {
  it("异 turn 的帧一律丢弃（别的标签页/上一轮的广播）", () => {
    const start = startStream("t1");
    const s = applyDelta(start, { turnId: "t2", seq: 0, ev: "delta", text: "别人的回复" });
    expect(s).toBe(start);
    expect(s.text).toBe("");
  });

  it("重复投递的同一帧只算一次", () => {
    let s = startStream("t1");
    s = applyDelta(s, { turnId: "t1", seq: 0, ev: "delta", text: "一次" });
    const before = s;
    s = applyDelta(s, { turnId: "t1", seq: 0, ev: "delta", text: "一次" });
    expect(s).toBe(before);
    expect(s.text).toBe("一次");
  });

  it("迟到的旧 seq 丢弃，新 seq 照收（乱序不会把正文搅乱）", () => {
    let s = startStream("t1");
    s = applyDelta(s, { turnId: "t1", seq: 5, ev: "delta", text: "第五帧" });
    s = applyDelta(s, { turnId: "t1", seq: 3, ev: "delta", text: "迟到的第三帧" });
    expect(s.text).toBe("第五帧");
    s = applyDelta(s, { turnId: "t1", seq: 6, ev: "delta", text: "第六帧" });
    expect(s.text).toBe("第五帧第六帧");
    expect(s.seq).toBe(6);
  });

  it("seq 单调：消费过的帧号只增不减", () => {
    let s = startStream("t1");
    const seen: number[] = [];
    for (const seq of [0, 1, 1, 0, 2, 3]) {
      s = applyDelta(s, { turnId: "t1", seq, ev: "delta", text: "x" });
      seen.push(s.seq);
    }
    expect(seen).toEqual([0, 1, 1, 1, 2, 3]);
  });
});

describe("事实源规则：invoke 返回后全量覆盖", () => {
  it("done 之后收尾清空，累积的正文不会漏进下一轮", () => {
    const streamed = feed(startStream("t1"), "t1", [{ ev: "delta", text: "上一轮说的话" }, { ev: "done" }]);
    const afterInvoke = clearStream(); // ChatDock 在 invoke 返回处调用，回复以响应为准
    expect(afterInvoke.text).toBe("");
    const next = startStream("t2");
    expect(next.text).toBe("");
    // 上一轮的迟到帧也进不来
    expect(applyDelta(next, { turnId: "t1", seq: streamed.seq + 1, ev: "delta", text: "迟到" })).toBe(next);
  });

  it("收尾后到达的帧一律丢弃（invoke 已经给出事实）", () => {
    const s = clearStream();
    expect(applyDelta(s, { turnId: "t1", seq: 9, ev: "delta", text: "余音" })).toBe(s);
  });
});

describe("parseDeltaFrame（坏帧不进状态机）", () => {
  it("完整帧照收", () => {
    expect(parseDeltaFrame({ turnId: "t1", seq: 2, ev: "delta", text: "字" })).toEqual({
      turnId: "t1",
      seq: 2,
      ev: "delta",
      text: "字",
    });
  });

  it("缺 turnId / seq 不是数字 / ev 不认识 → null", () => {
    expect(parseDeltaFrame({ seq: 1, ev: "delta" })).toBeNull();
    expect(parseDeltaFrame({ turnId: "t1", seq: "1", ev: "delta" })).toBeNull();
    expect(parseDeltaFrame({ turnId: "t1", seq: 1, ev: "typing" })).toBeNull();
  });

  it("reset/done 没有 text 也合法", () => {
    expect(parseDeltaFrame({ turnId: "t1", seq: 0, ev: "reset" })).toEqual({ turnId: "t1", seq: 0, ev: "reset" });
    expect(parseDeltaFrame({ turnId: "t1", seq: 7, ev: "done" })).toEqual({ turnId: "t1", seq: 7, ev: "done" });
  });
});
