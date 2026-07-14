import { describe, it, expect } from "vitest";
import { buildChatTools, type ChatCard, type ChatViewContext } from "./chat-router.js";
import type { ReviseFocus, ReviseFocusResult } from "../modules/writing/revise-focus.js";

function reviseTool(
  sink: ChatCard[],
  viewContext: ChatViewContext | undefined,
  impl: (contentId: string, instruction: string, focus: ReviseFocus, dataDir?: string) => Promise<ReviseFocusResult>,
) {
  const tools = buildChatTools(sink, undefined, { reviseFocusImpl: impl }, { contentIds: new Set<string>() }, viewContext);
  return tools.find((t) => t.name === "revise_focus")!;
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
