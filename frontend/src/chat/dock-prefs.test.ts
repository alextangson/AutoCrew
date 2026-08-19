/**
 * 总编辑栏常驻偏好（对话控制面设计 §Phase 3）。
 * 重点是「缺省翻转不覆盖老用户」这条迁移语义——它只在第一次升级时发生一次，错了没人再发现。
 */
import { describe, it, expect } from "vitest";
import {
  DOCK_WIDTH_DEFAULT, DOCK_WIDTH_MAX, DOCK_WIDTH_MIN,
  clampDockWidth, readDockOpen, readDockWidth, writeDockOpen, writeDockWidth, type PrefStore,
} from "./dock-prefs";

function fakeStore(seed: Record<string, string> = {}): PrefStore & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("dock 缺省态迁移", () => {
  it("没存过值的用户（含全新安装）默认展开", () => {
    expect(readDockOpen(fakeStore())).toBe(true);
  });

  it("手动收起过的老用户不被翻转（存了 \"0\" 就还是收起）", () => {
    expect(readDockOpen(fakeStore({ "dock-open": "0" }))).toBe(false);
  });

  it("展开过的老用户照旧展开", () => {
    expect(readDockOpen(fakeStore({ "dock-open": "1" }))).toBe(true);
  });

  it("store 不可用（隐私模式）时回默认展开，不抛", () => {
    expect(readDockOpen(null)).toBe(true);
    expect(() => writeDockOpen(false, null)).not.toThrow();
  });

  it("开合写回 1/0，下次读得到", () => {
    const store = fakeStore();
    writeDockOpen(false, store);
    expect(store.data["dock-open"]).toBe("0");
    expect(readDockOpen(store)).toBe(false);
    writeDockOpen(true, store);
    expect(readDockOpen(store)).toBe(true);
  });
});

describe("dock 宽度 clamp 与记忆", () => {
  it("范围内原样（取整）", () => {
    expect(clampDockWidth(420)).toBe(420);
    expect(clampDockWidth(420.6)).toBe(421);
    expect(clampDockWidth("380")).toBe(380);
  });

  it("越界夹到 320–560", () => {
    expect(clampDockWidth(10)).toBe(DOCK_WIDTH_MIN);
    expect(clampDockWidth(-9999)).toBe(DOCK_WIDTH_MIN);
    expect(clampDockWidth(9999)).toBe(DOCK_WIDTH_MAX);
  });

  it("坏值回默认 360（localStorage 是用户能手改的地方）", () => {
    for (const bad of ["", "abc", NaN, null, undefined, {}]) {
      expect(clampDockWidth(bad)).toBe(DOCK_WIDTH_DEFAULT);
    }
  });

  it("没存过 → 默认宽；存过坏值 → 默认宽；存过合法值 → 读回来", () => {
    expect(readDockWidth(fakeStore())).toBe(DOCK_WIDTH_DEFAULT);
    expect(readDockWidth(fakeStore({ "dock-width": "3" }))).toBe(DOCK_WIDTH_MIN);
    expect(readDockWidth(fakeStore({ "dock-width": "垃圾" }))).toBe(DOCK_WIDTH_DEFAULT);
    expect(readDockWidth(fakeStore({ "dock-width": "500" }))).toBe(500);
  });

  it("写入前也夹一次（越界值不会落盘）", () => {
    const store = fakeStore();
    writeDockWidth(10_000, store);
    expect(store.data["dock-width"]).toBe(String(DOCK_WIDTH_MAX));
    expect(readDockWidth(store)).toBe(DOCK_WIDTH_MAX);
  });
});
