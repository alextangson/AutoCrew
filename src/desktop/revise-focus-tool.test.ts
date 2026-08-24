import { describe, it, expect, vi } from "vitest";
import { buildChatTools, CREW_TOOL_STATUS, type ChatCard, type ChatToolDeps, type ChatViewContext } from "./chat-router.js";
import type { ReviseFocus, ReviseFocusResult } from "../modules/writing/revise-focus.js";

function toolset(sink: ChatCard[], viewContext: ChatViewContext | undefined, deps: ChatToolDeps) {
  const tools = buildChatTools(
    sink,
    undefined,
    deps,
    { contentIds: new Set<string>(), researchTopicIds: new Set<string>() },
    viewContext,
  );
  return (name: string) => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`工具未注册：${name}`);
    return found;
  };
}

function reviseTool(
  sink: ChatCard[],
  viewContext: ChatViewContext | undefined,
  impl: (contentId: string, instruction: string, focus: ReviseFocus, dataDir?: string) => Promise<ReviseFocusResult>,
) {
  return toolset(sink, viewContext, { reviseFocusImpl: impl })("revise_focus");
}

const CID = "content-123-abcxyz";

describe("revise_focus tool", () => {
  it("selection revision → pushes a revision_proposal card, no save", async () => {
    const sink: ChatCard[] = [];
    const tool = reviseTool(
      sink,
      { contentId: CID, revisionFocus: { scope: "selection", selection: "第二段偏书面。" } },
      async () => ({ kind: "revision", span: "第二段更口语了。" }),
    );
    const out = JSON.parse(await tool.execute({ instruction: "口语一点" }));
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("revision");
    expect(sink).toHaveLength(1);
    expect(sink[0].type).toBe("revision_proposal");
    expect(sink[0].data).toMatchObject({ contentId: CID, scope: "selection", span: "第二段更口语了。" });
  });

  it("ambiguous → returns a question, pushes no card", async () => {
    const sink: ChatCard[] = [];
    const tool = reviseTool(
      sink,
      { contentId: CID, revisionFocus: { scope: "selection", selection: "第二段。" } },
      async () => ({ kind: "question", question: "更有网感是指开头还是整段？" }),
    );
    const out = JSON.parse(await tool.execute({ instruction: "更有网感" }));
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("question");
    expect(out.question).toContain("网感");
    expect(sink).toHaveLength(0);
  });

  it("no focus → fails, does not call the impl", async () => {
    const sink: ChatCard[] = [];
    let called = false;
    const tool = reviseTool(sink, { contentId: CID }, async () => {
      called = true;
      return { kind: "revision", span: "x" };
    });
    const out = JSON.parse(await tool.execute({ instruction: "改改" }));
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
  });
});

/**
 * 焦点的出口（真机 dogfood 死循环修复）：焦点只有 clearFocus() 能清，
 * 模型手里必须有这把钥匙，否则它只能编一句「去编辑器取消选区」把用户绕死。
 */
describe("clear_revision_focus tool", () => {
  const FOCUSED: ChatViewContext = { contentId: CID, revisionFocus: { scope: "selection", selection: "第二段。" } };

  const revised = () => ({
    content: { id: CID, title: "新标题", body: "新正文", platform: "wechat_mp", status: "draft_ready", versions: [{ version: 1 }, { version: 2 }] },
    tokensUsed: 10,
  });

  it("注册进 buildChatTools，且有角色署名与人话标签", () => {
    const tool = toolset([], FOCUSED, {})("clear_revision_focus");
    expect(tool.description.length).toBeGreaterThan(0);
    const status = CREW_TOOL_STATUS.clear_revision_focus;
    expect(status).toBeDefined();
    expect(status.role).toBe("writer");
    expect(status.label.length).toBeGreaterThan(0);
  });

  it("执行 → 回执告诉模型可以接着用常规工具，并推一张 focus_cleared 卡", async () => {
    const sink: ChatCard[] = [];
    const out = JSON.parse(await toolset(sink, FOCUSED, {})("clear_revision_focus").execute({}));
    expect(out.ok).toBe(true);
    expect(String(out.note)).toContain("revise_draft");
    expect(sink).toEqual([{ type: "focus_cleared", data: {} }]);
  });

  it("退出后同一轮 revise_draft 立刻放行（不必等用户再发一轮）", async () => {
    const sink: ChatCard[] = [];
    const reviseDraftImpl = vi.fn(async () => revised()) as never;
    const tool = toolset(sink, FOCUSED, { reviseDraftImpl });

    const blocked = JSON.parse(await tool("revise_draft").execute({ content_id: CID, instruction: "整篇重写" }));
    expect(blocked.ok).toBe(false);
    expect(reviseDraftImpl).not.toHaveBeenCalled();

    await tool("clear_revision_focus").execute({});
    const after = JSON.parse(await tool("revise_draft").execute({ content_id: CID, instruction: "整篇重写" }));
    expect(after.ok).toBe(true);
    expect(reviseDraftImpl).toHaveBeenCalledTimes(1);
    expect(sink.map((c) => c.type)).toEqual(["focus_cleared", "draft"]);
  });

  it("无焦点时误调 → 回 ok 但不推卡（不给用户看空回执）", async () => {
    const sink: ChatCard[] = [];
    const out = JSON.parse(await toolset(sink, { contentId: CID }, {})("clear_revision_focus").execute({}));
    expect(out.ok).toBe(true);
    expect(String(out.note)).toContain("没有修改焦点");
    expect(sink).toHaveLength(0);
  });

  it("退出后同一轮 revise_focus 不再可用（焦点真的没了，不是只改了句文案）", async () => {
    const sink: ChatCard[] = [];
    const reviseFocusImpl = vi.fn(async () => ({ kind: "revision", span: "x" }) as ReviseFocusResult);
    const tool = toolset(sink, FOCUSED, { reviseFocusImpl });

    await tool("clear_revision_focus").execute({});
    const out = JSON.parse(await tool("revise_focus").execute({ instruction: "口语一点" }));
    expect(out.ok).toBe(false);
    expect(reviseFocusImpl).not.toHaveBeenCalled();
  });
});
