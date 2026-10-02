// @vitest-environment happy-dom
/** e2e 1002b N4：首次开机引导页上面，更新结果弹窗照样看得见；没有结果时只有引导。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let stored: unknown = null;
vi.mock("../update/update-api", () => ({
  loadUpdate: async () => ({ ok: true, data: { running: false, result: stored } }),
  ackResult: async () => ({ ok: true, data: {} }),
}));
vi.mock("../Onboarding", () => ({ Onboarding: () => createElement("div", { "data-testid": "onboarding" }, "首次开机引导") }));

let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stored = null;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const mount = async () => {
  const { OnboardingGate } = await import("./OnboardingGate");
  await act(async () => root.render(createElement(OnboardingGate, { onDone: () => {} })));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

describe("OnboardingGate", () => {
  it("有一份「需要手动恢复」的更新结果：引导页上面照样显示标题和恢复命令", async () => {
    stored = { ok: false, outcome: "stuck", from: "0.4.9", to: "0.5.0", message: "上次更新中断了…", log: "/l", manualCommands: ["git reset --hard abc123", "npm run restart"] };
    await mount();
    expect(el.querySelector("[data-testid=onboarding]")).toBeTruthy();
    expect(el.textContent).toContain("更新失败，需要你手动恢复");
    expect(el.querySelector(".upd-cmds")?.textContent).toContain("git reset --hard abc123");
  });

  it("没有更新结果：只有引导页", async () => {
    await mount();
    expect(el.querySelector("[data-testid=onboarding]")).toBeTruthy();
    expect(el.querySelector(".upd-overlay")).toBeNull();
  });
});

import fs from "node:fs";
import path from "node:path";
describe("App 接上了这层", () => {
  it("引导分支渲染的是 OnboardingGate，不是光秃秃的 Onboarding", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "App.tsx"), "utf-8");
    expect(src).toContain("<OnboardingGate onDone=");
    expect(src).not.toMatch(/<Onboarding onDone=/);
  });
});
