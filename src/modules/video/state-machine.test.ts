/**
 * state-machine.test.ts —— phase × state 迁移表（spec §2.2）。
 * 表本身在这里被逐条锁定：改表必须改测试，改测试必须回去改 spec。
 */
import { describe, it, expect } from "vitest";
import {
  AUTO_CHAIN_PHASES,
  PHASE_ADVANCING_EDGES,
  PHASE_REGRESSION_EDGES,
  VIDEO_PHASE_ORDER,
  VIDEO_STATE_TRANSITIONS,
  assertTransition,
  canTransition,
  videoTransitionError,
  type VideoStateRef,
} from "./state-machine.js";

const at = (phase: string, state: string) => ({ phase, state }) as VideoStateRef;

describe("迁移表锁定（spec §2.2 原文）", () => {
  it("阶段顺序：ingest→transcribe→cut→assemble→render→review→done", () => {
    expect(VIDEO_PHASE_ORDER).toEqual([
      "ingest", "transcribe", "cut", "assemble", "render", "review", "done",
    ]);
  });

  it("状态边就是 spec 列的那几条（v2.1 修正后），一条不多一条不少", () => {
    expect(VIDEO_STATE_TRANSITIONS).toEqual({
      idle: ["queued"],
      queued: ["running"],
      running: ["awaiting_human", "failed", "blocked", "queued"],
      awaiting_human: ["queued", "done", "awaiting_human"],
      blocked: ["queued"],
      failed: ["queued"],
      done: ["queued"],
    });
  });

  it("只有五条边允许顺带推进阶段", () => {
    expect(PHASE_ADVANCING_EDGES).toEqual([
      "idle->queued", "running->awaiting_human", "running->queued",
      "awaiting_human->queued", "awaiting_human->done",
    ]);
  });

  it("自动接续只有两对相邻阶段；回退白名单只有打回与重开两条", () => {
    expect(AUTO_CHAIN_PHASES).toEqual([["ingest", "transcribe"], ["assemble", "render"]]);
    expect(PHASE_REGRESSION_EDGES).toEqual([
      { from: { phase: "review", state: "awaiting_human" }, to: { phase: "cut", state: "awaiting_human" } },
      { from: { phase: "done", state: "done" }, to: { phase: "assemble", state: "queued" } },
    ]);
  });
});

describe("合法迁移", () => {
  it("投递：ingest/idle → transcribe/queued", () => {
    expect(videoTransitionError(at("ingest", "idle"), at("transcribe", "queued"))).toBeNull();
  });

  it("claim：queued → running，阶段停在原地", () => {
    expect(canTransition(at("transcribe", "queued"), at("transcribe", "running"))).toBe(true);
  });

  it("产物落地交人工门：transcribe/running → cut/awaiting_human", () => {
    expect(canTransition(at("transcribe", "running"), at("cut", "awaiting_human"))).toBe(true);
  });

  it("人工确认推进下一阶段：cut/awaiting_human → assemble/queued", () => {
    expect(canTransition(at("cut", "awaiting_human"), at("assemble", "queued"))).toBe(true);
  });

  it("失败与阻塞：running → failed / blocked，随后都能回 queued 重投同阶段", () => {
    expect(canTransition(at("render", "running"), at("render", "failed"))).toBe(true);
    expect(canTransition(at("render", "running"), at("render", "blocked"))).toBe(true);
    expect(canTransition(at("render", "failed"), at("render", "queued"))).toBe(true);
    expect(canTransition(at("render", "blocked"), at("render", "queued"))).toBe(true);
  });

  it("审片确认收尾：review/awaiting_human → done/done", () => {
    expect(canTransition(at("review", "awaiting_human"), at("done", "done"))).toBe(true);
  });

  it("阶段自动接续：ingest/running → transcribe/queued、assemble/running → render/queued", () => {
    expect(videoTransitionError(at("ingest", "running"), at("transcribe", "queued"))).toBeNull();
    expect(videoTransitionError(at("assemble", "running"), at("render", "queued"))).toBeNull();
  });

  it("同阶段 running → queued 合法（启动回收过期 running 重排）", () => {
    expect(canTransition(at("render", "running"), at("render", "queued"))).toBe(true);
  });

  it("审片打回：review/awaiting_human → cut/awaiting_human", () => {
    expect(videoTransitionError(at("review", "awaiting_human"), at("cut", "awaiting_human"))).toBeNull();
  });

  it("重开：done/done → assemble/queued（对已完成内容提交新 cut）", () => {
    expect(videoTransitionError(at("done", "done"), at("assemble", "queued"))).toBeNull();
  });

  it("原地更新（只改 revisions/stale 等负载）恒合法", () => {
    expect(canTransition(at("assemble", "running"), at("assemble", "running"))).toBe(true);
    expect(canTransition(at("done", "done"), at("done", "done"))).toBe(true);
  });
});

describe("非法迁移", () => {
  it("人工门不可绕过：transcribe/running 不能自动接 cut/queued，render 完必须停审片", () => {
    const err = videoTransitionError(at("transcribe", "running"), at("cut", "queued"));
    expect(err).toContain("人工门不可绕过");
    expect(videoTransitionError(at("render", "running"), at("review", "queued"))).toContain("人工门不可绕过");
  });

  it("跳过 claim：queued 不能直接 awaiting_human", () => {
    expect(canTransition(at("transcribe", "queued"), at("transcribe", "awaiting_human"))).toBe(false);
  });

  it("白名单外的阶段回退一律拒绝", () => {
    expect(videoTransitionError(at("render", "awaiting_human"), at("cut", "queued"))).toContain("阶段回退只允许");
    expect(videoTransitionError(at("done", "done"), at("cut", "queued"))).toContain("阶段回退只允许");
    expect(videoTransitionError(at("review", "awaiting_human"), at("transcribe", "awaiting_human"))).toContain("阶段回退只允许");
  });

  it("重试不许换阶段：failed→queued 必须停在 failedPhase", () => {
    const err = videoTransitionError(at("render", "failed"), at("review", "queued"));
    expect(err).toContain("不许换阶段");
  });

  it("claim 不许换阶段", () => {
    expect(canTransition(at("assemble", "queued"), at("render", "running"))).toBe(false);
  });

  it("done 只能由 review 的人工确认到达", () => {
    expect(videoTransitionError(at("render", "awaiting_human"), at("done", "done")))
      .toContain("只有 review 的人工确认");
  });

  it("phase 与 state 的 done 必须成对出现", () => {
    expect(videoTransitionError(at("review", "awaiting_human"), at("review", "done")))
      .toContain("必须同为 done");
    expect(videoTransitionError(at("review", "awaiting_human"), at("done", "queued")))
      .toContain("必须同为 done");
  });

  it("done 不能原阶段重排：done/done → done/queued 违反 done 成对规则", () => {
    expect(canTransition(at("done", "done"), at("done", "queued"))).toBe(false);
    expect(videoTransitionError(at("done", "done"), at("done", "queued"))).toContain("必须同为 done");
  });

  it("未知枚举值（损坏的 state.json）被点名，不是靠 undefined 崩", () => {
    expect(videoTransitionError(at("wat", "idle"), at("transcribe", "queued"))).toContain("phase 未知");
    expect(videoTransitionError(at("ingest", "idle"), at("transcribe", "wat"))).toContain("state 未知");
  });
});

describe("assertTransition", () => {
  it("合法不抛，非法抛且信息里带 from/to", () => {
    expect(() => assertTransition(at("ingest", "idle"), at("transcribe", "queued"))).not.toThrow();
    expect(() => assertTransition(at("cut", "awaiting_human"), at("cut", "running")))
      .toThrow(/cut\/awaiting_human → cut\/running/);
  });
});
