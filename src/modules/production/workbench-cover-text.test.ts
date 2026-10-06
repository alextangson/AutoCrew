import { beforeEach, expect, it, vi } from "vitest";

const decide = vi.fn(async () => ({ ok: true }));
let decisions: { cover_text?: string } | null = null;
vi.mock("./inbox-decide.js", () => ({ decide }));
vi.mock("./reconcile.js", () => ({ reconcileContent: vi.fn(async () => {}) }));
vi.mock("../../storage/production-store.js", () => ({ readProductionDocOrEmpty: vi.fn(async () => ({ round: 1, facts: [] })) }));
vi.mock("../video/handoff/project-evidence.js", () => ({ readProjectJson: vi.fn(async () => decisions) }));

const { workbenchDecision } = await import("./workbench.js");
const content = { id: "c1" } as never;
const approve = (extra: Record<string, unknown> = {}) => workbenchDecision(content, "/data", { action: "approve", which: "covers", files: [], ...extra });
const sent = () => (decide.mock.calls.at(-1) as unknown as [string, string, Record<string, unknown>])[2];

beforeEach(() => { decide.mockClear(); decisions = null; });

// Codex 审 P2：旧工作台不传字 ≠ 创始人故意清空，不能把组里自带的字冲掉
it("页面没带字、交接也没定字：不传 cover_text，让组里的字顶上", async () => {
  await approve();
  expect(sent()).not.toHaveProperty("cover_text");
  decisions = { cover_text: "" };
  await approve();
  expect(sent()).not.toHaveProperty("cover_text");
});

it("页面没带字时用交接定的字；页面带了（含空串）就照页面", async () => {
  decisions = { cover_text: "交接的字" };
  await approve();
  expect(sent()).toMatchObject({ cover_text: "交接的字" });
  await approve({ cover_text: "" });
  expect(sent()).toMatchObject({ cover_text: "" });
  await approve({ cover_text: "页面的字" });
  expect(sent()).toMatchObject({ cover_text: "页面的字" });
});
