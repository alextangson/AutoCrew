// @vitest-environment happy-dom
/** 看板：O18「补全画像」提醒不拦路；O20 示例卡一键删 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const s: { status: Record<string, unknown> | null; calls: Array<[string, unknown]>; toasts: string[] } = { status: null, calls: [], toasts: [] };
vi.mock("../transport", () => ({
  invoke: async (ch: string, p: unknown) => {
    s.calls.push([ch, p]);
    if (ch === "onboarding:status") return s.status ? { ok: true, data: s.status } : { ok: false, error: "读档案失败" };
    return { ok: true, data: {} };
  },
}));
vi.mock("../ui", () => ({ toast: (t: string) => { s.toasts.push(t); } }));

let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  s.calls = []; s.toasts = [];
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const btn = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement | undefined;

async function reminder() {
  const { PersonaReminder } = await import("./PersonaReminder");
  await act(async () => root.render(createElement(PersonaReminder))); await tick();
}

it("O18: skipped persona → reminder with a fill-in button; opening shows the same form", async () => {
  s.status = { onboarded: false, personaComplete: false, personaSkipped: true };
  await reminder();
  expect(el.textContent).toContain("补全画像");
  await act(async () => btn("补全画像")!.click()); await tick();
  expect(el.textContent).toContain("你是做什么的");
});

it("complete persona, or an old profile that was never skipped → no reminder", async () => {
  s.status = { onboarded: true, personaComplete: true, personaSkipped: false };
  await reminder();
  expect(el.textContent).toBe("");
  s.status = { onboarded: true, personaComplete: false, personaSkipped: false };
  await reminder();
  expect(el.textContent).toBe("");
});

it("status read failure is shown, not hidden", async () => {
  s.status = null;
  await reminder();
  expect(el.textContent).toContain("读不到画像状态：读档案失败");
});

it("O20: example tag deletes the example topic in one click and reloads", async () => {
  const { ExampleTag } = await import("./ExampleTag");
  let reloaded = 0;
  await act(async () => root.render(createElement(ExampleTag, { topicId: "topic-1", reload: async () => { reloaded++; } }))); await tick();
  expect(el.textContent).toContain("示例");
  await act(async () => btn("删掉示例")!.click()); await tick();
  expect(s.calls).toContainEqual(["topic:delete_example", { id: "topic-1" }]);
  expect(s.toasts[0]).toContain("回收站");
  expect(reloaded).toBe(1);
});
