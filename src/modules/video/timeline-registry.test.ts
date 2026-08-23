/**
 * timeline-registry.test.ts —— 受控枚举的单一事实源（spec §2.7）。
 *
 * 这份 JSON 被两个 workspace 各读一遍（主进程校验 + render CLI 二次校验），
 * 禁止跨 workspace import TS 源码。所以它必须：是纯 JSON、结构稳定、
 * 每个枚举项都真的有组件落地——V0 只登记进了库的那几款（§6.3「进库才进生产」）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TIMELINE_REGISTRY } from "./timeline-validate.js";

const REGISTRY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "timeline-registry.json",
);

describe("timeline-registry.json", () => {
  it("是纯 JSON，磁盘上的内容与主进程读到的一字不差", () => {
    const onDisk = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
    expect(onDisk).toEqual(TIMELINE_REGISTRY);
  });

  it("V0 枚举各一款，schemaVersion 为 1", () => {
    expect(TIMELINE_REGISTRY).toEqual({
      schemaVersion: 1,
      graphics: { "code-block": { props: { code: "string", lang: "string" } } },
      captions: ["plain"],
      titles: ["hook-title"],
      transitions: ["cut", "fade"],
    });
  });

  it("props 的类型名限于 JS typeof 能判定的三种（校验器只认这些）", () => {
    const declared = Object.values(TIMELINE_REGISTRY.graphics).flatMap((g) => Object.values(g.props));
    expect(declared.every((t) => ["string", "number", "boolean"].includes(t))).toBe(true);
  });
});
