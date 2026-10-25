import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decidePromotion, proposePromotion, readPromotions, releaseEvidence, releaseFoldedPromotions, type Promotion } from "./promotions.js";
import { SKILL_FILE } from "./method.js";
import { promotionItems } from "../production/chat-approval/promotion-decide.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "promo-release-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const cites = [{ content_id: "c1", index: 1, founder_words: "a" }, { content_id: "c2", index: 1, founder_words: "b" }];
async function approved(text: string): Promise<string> {
  const { id } = await proposePromotion({ target: "method", text, reason: "r", cites }, dir);
  const gen = (await readPromotions(dir)).find((p) => p.id === id)!.gen;
  await decidePromotion(id, gen, "approve", "批", dir);
  return id;
}
async function skillWith(body: string, extra = ""): Promise<string> {
  const f = path.join(dir, "SKILL.md");
  await fs.writeFile(f, `前\n<!-- method:start -->\n${body}\n<!-- method:end -->\n${extra}后`);
  return f;
}

describe("写法补丁合进技能后自动生效", () => {
  it("批了但没合进技能 → 一直留在「等发布」", async () => {
    const id = await approved("开头先亮主题钩子。");
    const skill = await skillWith("别的写法");
    const items = await promotionItems(dir, skill);
    expect(items.map((i) => i.item_id)).toContain(`promotion-release:${id}`);
    expect((await readPromotions(dir))[0].status).toBe("approved_pending_release");
  });

  it("技能「写法」一节里有改动全文（空白、标点不同也算）→ released 并从列表消失", async () => {
    const id = await approved("开头先亮主题钩子，再给画面。");
    const skill = await skillWith("- 开头 先亮主题钩子；再给画面！还有别的");
    expect(await promotionItems(dir, skill)).toEqual([]);
    expect((await readPromotions(dir)).find((p) => p.id === id)).toMatchObject({ status: "released", released_evidence: "text" });
  });

  it("措辞改过但有折入标记 → released；标记里是别的 id 不算", async () => {
    const id = await approved("原话");
    expect(releaseEvidence((await readPromotions(dir))[0], "<!-- promotion-folded: wp-other -->")).toBeNull();
    const skill = await skillWith("改写过的写法", `<!-- promotion-folded: wp-other ${id} -->\n`);
    expect(await releaseFoldedPromotions(dir, skill)).toHaveLength(1);
    expect((await readPromotions(dir))[0]).toMatchObject({ status: "released", released_evidence: "marker" });
  });

  it("只出现在「写法」一节外面的全文不算证据", async () => {
    await approved("开头先亮主题钩子。");
    const skill = await skillWith("别的", "开头先亮主题钩子。\n");
    expect(await releaseFoldedPromotions(dir, skill)).toEqual([]);
  });

  it("技能文件读不了 → 列一件看得见的错误，不当成已生效", async () => {
    await approved("x");
    const items = await promotionItems(dir, path.join(dir, "nope.md"));
    expect(items[0]).toMatchObject({ item_id: "promotion:error" });
    expect((await readPromotions(dir))[0].status).toBe("approved_pending_release");
  });

  it("仓库技能文件里带着 10-22 合入的三份补丁的标记", async () => {
    const skill = await fs.readFile(SKILL_FILE, "utf8");
    for (const id of ["wp-a93c383e-795c-479a-9d6d-67aeaedf4071", "wp-6a124dd8-b134-4aa2-b4d1-0cc53f7bd45f", "wp-152207bd-5827-4793-833e-c4effe56e965"])
      expect(releaseEvidence({ id, text: "不在技能里的原文" } as Promotion, skill)).toBe("marker");
    expect(releaseEvidence({ id: "wp-d1a146f1-8a8c-4bf9-a12f-53857b7a791d", text: "段和段要接上" } as Promotion, skill)).toBeNull();
  });
});
