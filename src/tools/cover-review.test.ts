/**
 * cover-review.test.ts — 封面工具:候选生成(设计师/规则降级)、修订闭环、
 * 平台比例、审批修复(approvedImagePath / 状态不倒拨)、createdAt 保留。
 * designer / gemini / wide-crop 全 mock,存储走真实临时目录。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../modules/cover/designer.js", () => ({
  designCoverPlan: vi.fn(),
  reviseCoverDesign: vi.fn(),
}));
vi.mock("../adapters/image/gemini.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../adapters/image/gemini.js")>();
  return { ...orig, generateImage: vi.fn() };
});
vi.mock("../adapters/image/relay-cover.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../adapters/image/relay-cover.js")>();
  return { ...orig, generateCoverViaRelay: vi.fn() };
});
vi.mock("../modules/cover/wide-crop.js", () => ({ generateWideCover: vi.fn() }));

import { executeCoverReview } from "./cover-review.js";
import { designCoverPlan, reviseCoverDesign, type CoverDesign } from "../modules/cover/designer.js";
import { generateImage } from "../adapters/image/gemini.js";
import { generateCoverViaRelay } from "../adapters/image/relay-cover.js";
import { generateWideCover } from "../modules/cover/wide-crop.js";
import { saveContent, getContent, getCoverReview, saveCoverReview } from "../storage/local-store.js";
import { claimContent } from "../storage/claims.js";
import { encodePng } from "../modules/cover/png-crop.js";

const planMock = vi.mocked(designCoverPlan);
const reviseMock = vi.mocked(reviseCoverDesign);
const genMock = vi.mocked(generateImage);
const relayMock = vi.mocked(generateCoverViaRelay);
const wideMock = vi.mocked(generateWideCover);

let dir: string;

const LONG_PROMPT =
  "Vertical 3:4 portrait orientation cover image. Cinematic photo-realism with bold Chinese title text overlay.";

const design = (label: "A" | "B" | "C", extra?: Partial<CoverDesign>): CoverDesign => ({
  label,
  style: `本文创意-${label}`,
  creativeConcept: `把本文证据转成方案 ${label} 的独有视觉点子`,
  visualMedium: label === "B" ? "paper collage" : "documentary photography",
  palette: label === "C" ? "high-key white and red" : "paper white and graphite",
  titleText: "封面大字",
  imagePrompt: LONG_PROMPT,
  layoutHint: "标题上 1/3",
  designReason: "能停住滑动",
  ...extra,
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-coverreview-"));
  planMock.mockReset();
  reviseMock.mockReset();
  genMock.mockReset();
  relayMock.mockReset();
  wideMock.mockReset();
  planMock.mockResolvedValue({ designs: [design("A"), design("B"), design("C")], tokensUsed: 100 });
  genMock.mockImplementation(async (opts) => {
    const p = `${opts.outputPath}.png`;
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, Buffer.from("png-bytes"));
    return { ok: true, imagePath: p, model: "mock-model" };
  });
  relayMock.mockImplementation(async (opts) => {
    const p = `${opts.outputPath}.png`;
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, Buffer.from("relay-png"));
    return { ok: true, imagePath: p, model: "gpt-image-2" };
  });
  // 存量用例走 gemini 分支(V5.6.1 默认 provider 改为 relay,这里显式锁定)
  await fs.writeFile(path.join(dir, "cover.json"), JSON.stringify({ provider: "gemini" }), "utf-8");
});

async function switchToRelay(): Promise<void> {
  await fs.writeFile(path.join(dir, "cover.json"), JSON.stringify({ provider: "relay" }), "utf-8");
  await fs.writeFile(
    path.join(dir, "publish.json"),
    JSON.stringify({
      wechatMp: { imageApiKey: "sk-relay", imageBaseUrl: "https://relay.test/v1", imageModel: "gpt-image-2" },
    }),
    "utf-8",
  );
}

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function seedContent(status = "draft_ready", platform = "wechat_mp"): Promise<string> {
  const c = await saveContent(
    { title: "AI 写码的账", body: "正文内容", platform, status: status as never, tags: [], hashtags: [] },
    dir,
  );
  return c.id;
}

async function createCandidates(contentId: string): Promise<Record<string, unknown>> {
  return (await executeCoverReview({
    action: "create_candidates",
    content_id: contentId,
    _dataDir: dir,
    _geminiApiKey: "k",
  })) as Record<string, unknown>;
}

describe("create_candidates", () => {
  it("设计师方案 → 3 张候选,r1 文件名,designSource=designer", async () => {
    const id = await seedContent();
    const r = (await createCandidates(id)) as {
      ok: boolean;
      designSource: string;
      review: {
        designSource?: string;
        variants: Array<{
          imagePaths: Record<string, string>;
          revision?: number;
          designReason?: string;
          creativeConcept?: string;
        }>;
      };
    };
    expect(r.ok).toBe(true);
    expect(r.designSource).toBe("designer");
    expect(r.review.designSource).toBe("designer");
    expect(r.review.variants).toHaveLength(3);
    for (const v of r.review.variants) {
      expect(v.revision).toBe(1);
      expect(v.imagePaths["3:4"]).toContain("-r1");
      expect(v.creativeConcept).toBeTruthy();
    }
  });

  it("设计师失败 → 降级规则版(designSource=rules),候选照出", async () => {
    planMock.mockRejectedValueOnce(new Error("engine down"));
    const id = await seedContent();
    const r = (await createCandidates(id)) as {
      ok: boolean;
      designSource: string;
      review: { designSource?: string; variants: Array<{ creativeConcept?: string }> };
    };
    expect(r.ok).toBe(true);
    expect(r.designSource).toBe("rules");
    expect(r.review.designSource).toBe("rules");
    expect(r.review.variants).toHaveLength(3);
    expect(new Set(r.review.variants.map((v) => v.creativeConcept)).size).toBe(3);
  });

  it("重出候选 → revision 递增,createdAt 保留首次值", async () => {
    const id = await seedContent();
    await createCandidates(id);
    const first = await getCoverReview(id, dir);
    await new Promise((r) => setTimeout(r, 5));
    const r2 = (await createCandidates(id)) as { review: { variants: Array<{ revision?: number }> } };
    expect(r2.review.variants[0].revision).toBe(2);
    const second = await getCoverReview(id, dir);
    expect(second!.createdAt).toBe(first!.createdAt);
    expect(second!.updatedAt).not.toBe(first!.updatedAt);
  });

  it("读取个人封面标准，并把当前身份照排在参考图第一位", async () => {
    const refsDir = path.join(dir, "covers", "templates");
    await fs.mkdir(refsDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(refsDir, "studio.jpg"), Buffer.from("studio")),
      fs.writeFile(path.join(refsDir, "current.png"), Buffer.from("current")),
      fs.writeFile(path.join(refsDir, "other.webp"), Buffer.from("other")),
    ]);
    await fs.writeFile(
      path.join(dir, "cover-style.json"),
      JSON.stringify({
        version: 1,
        name: "人物清晰的编辑封面",
        referenceImages: [
          { filename: "current.png", role: "identity", priority: 0 },
          { filename: "studio.jpg", role: "editorial", priority: 10 },
        ],
        visualRules: ["人物低颗粒"],
        identityRules: ["当前生活照优先锁脸"],
        typographyRules: [],
        layoutRules: ["人物位于标题前方且完全不透明"],
        avoid: [],
        qualityGates: [],
      }),
      "utf-8",
    );
    const id = await seedContent();
    await createCandidates(id);
    expect(planMock.mock.calls[0][0].styleProfile?.identityRules).toContain("当前生活照优先锁脸");
    expect(genMock.mock.calls[0][0].referenceImagePaths?.map((item) => path.basename(item))).toEqual([
      "current.png",
      "studio.jpg",
      "other.webp",
    ]);
  });
});

describe("approve(存量 bug 修复)", () => {
  it("approvedImagePath 取 imagePaths['3:4'](旧字段 imagePath 从未赋值)", async () => {
    const id = await seedContent();
    await createCandidates(id);
    const r = (await executeCoverReview({ action: "approve", content_id: id, label: "b", _dataDir: dir })) as {
      ok: boolean;
      review: { approvedImagePath?: string; variants: Array<{ label: string; imagePaths: Record<string, string> }> };
    };
    expect(r.ok).toBe(true);
    const b = r.review.variants.find((v) => v.label === "b")!;
    expect(r.review.approvedImagePath).toBe(b.imagePaths["3:4"]);
    expect(r.review.approvedImagePath).toBeTruthy();
  });

  // 阶段制（spec §0 清扫 1）：选封面只做标记,推进阶段是人的动作,批准不许代改稿件状态
  it.each(["publish_ready", "draft_ready", "cover_pending"])("选封面不动稿件状态（%s）", async (status) => {
    const id = await seedContent(status);
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    const content = await getContent(id, dir);
    expect(content!.status).toBe(status);
  });

  it("人机协同:选定封面复制到文件夹根 封面.png(拿了就走)", async () => {
    const id = await seedContent();
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "b", _dataDir: dir });
    const copy = await fs.readFile(path.join(dir, "contents", id, "封面.png"));
    expect(copy.equals(Buffer.from("png-bytes"))).toBe(true);
  });
});

describe("revise(反馈重做闭环)", () => {
  it("按反馈重做单张:revision+1、feedback 留痕、原选用作废", async () => {
    const id = await seedContent();
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    reviseMock.mockResolvedValueOnce(design("A", { titleText: "更狠大字", designReason: "按反馈加强" }));

    const r = (await executeCoverReview({
      action: "revise",
      content_id: id,
      label: "a",
      feedback: "标题太温",
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as {
      ok: boolean;
      revision: number;
      review: {
        status: string;
        approvedLabel?: string;
        feedback?: Array<{ label: string; note: string; prevPrompt?: string }>;
        variants: Array<{ label: string; titleText?: string; revision?: number; imagePaths: Record<string, string> }>;
      };
    };
    expect(r.ok).toBe(true);
    expect(r.revision).toBe(2);
    const a = r.review.variants.find((v) => v.label === "a")!;
    expect(a.titleText).toBe("更狠大字");
    expect(a.imagePaths["3:4"]).toContain("-r2");
    expect(r.review.feedback).toHaveLength(1);
    expect(r.review.feedback![0]).toMatchObject({ label: "a", note: "标题太温" });
    expect(r.review.feedback![0].prevPrompt).toBeTruthy();
    // 修订过的方案曾被选用 → 选用作废回待审
    expect(r.review.status).toBe("review_pending");
    expect(r.review.approvedLabel).toBeUndefined();
  });

  // 阶段制 spec §1.2：撤销批准不许留下「发布就绪但封面作废」的错位态
  it("已在待发布的稿件撤销封面批准 → 同步降级回封面设计,并给出可 toast 的说明", async () => {
    const id = await seedContent("publish_ready");
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    reviseMock.mockResolvedValueOnce(design("A", { titleText: "再来一版" }));

    const r = (await executeCoverReview({
      action: "revise",
      content_id: id,
      label: "a",
      feedback: "标题太温",
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as { ok: boolean; statusNote?: string };

    expect(r.ok).toBe(true);
    expect((await getContent(id, dir))!.status).toBe("cover_pending");
    expect(r.statusNote).toContain("封面设计");
  });

  it("重做的不是被选用的那张 → 不碰稿件状态", async () => {
    const id = await seedContent("publish_ready");
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    reviseMock.mockResolvedValueOnce(design("B", { titleText: "改 B" }));

    const r = (await executeCoverReview({
      action: "revise",
      content_id: id,
      label: "b",
      feedback: "B 再狠一点",
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as { ok: boolean; statusNote?: string };

    expect(r.ok).toBe(true);
    expect(r.statusNote).toBeUndefined();
    expect((await getContent(id, dir))!.status).toBe("publish_ready");
  });

  it("缺 feedback → 明确报错", async () => {
    const id = await seedContent();
    await createCandidates(id);
    const r = (await executeCoverReview({
      action: "revise",
      content_id: id,
      label: "a",
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("feedback");
  });
});

describe("relay provider(V5.6.1 中转 image2)", () => {
  it("create_candidates 走中转:targetAspect 3:4,relay 凭证来自 publish.json,不碰 gemini", async () => {
    await switchToRelay();
    const id = await seedContent();
    const r = (await executeCoverReview({ action: "create_candidates", content_id: id, _dataDir: dir })) as {
      ok: boolean;
      provider: string;
      review: { variants: unknown[] };
    };
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("relay");
    expect(r.review.variants).toHaveLength(3);
    expect(genMock).not.toHaveBeenCalled();
    const call = relayMock.mock.calls[0][0];
    expect(call.targetAspect).toBe("3:4");
    expect(call.relay).toMatchObject({ apiKey: "sk-relay", baseUrl: "https://relay.test/v1", model: "gpt-image-2" });
  });

  it("参考图降级 warning 透出,hasPersonalIP 如实置 false", async () => {
    await switchToRelay();
    await fs.mkdir(path.join(dir, "covers", "templates"), { recursive: true });
    await fs.writeFile(path.join(dir, "covers", "templates", "me.jpg"), Buffer.from("photo"));
    relayMock.mockImplementation(async (opts) => {
      const p = `${opts.outputPath}.png`;
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, Buffer.from("relay-png"));
      return {
        ok: true,
        imagePath: p,
        model: "gpt-image-2",
        warning: "中转不支持参考图(/images/edits),本次未带人物形象",
      };
    });
    const id = await seedContent();
    const r = (await executeCoverReview({ action: "create_candidates", content_id: id, _dataDir: dir })) as {
      ok: boolean;
      warnings?: string[];
      review: { variants: Array<{ hasPersonalIP?: boolean }> };
    };
    expect(r.ok).toBe(true);
    expect(r.warnings!.some((w) => w.includes("未带人物"))).toBe(true);
    expect(r.review.variants.every((v) => v.hasPersonalIP === false)).toBe(true);
  });

  it("局部修订只把框选 mask 交给 image2，框外不走整图重画", async () => {
    await switchToRelay();
    const refsDir = path.join(dir, "covers", "templates");
    await fs.mkdir(refsDir, { recursive: true });
    await fs.writeFile(path.join(refsDir, "current.jpg"), Buffer.from("identity-photo"));
    const id = await seedContent();
    await createCandidates(id);
    const review = await getCoverReview(id, dir);
    const sourcePath = review!.variants.find((variant) => variant.label === "a")!.imagePaths["3:4"]!;
    const rows = Array.from({ length: 16 }, () => Buffer.alloc(12 * 4, 180));
    await fs.writeFile(sourcePath, encodePng(12, 16, 4, rows));
    relayMock.mockClear();

    const result = (await executeCoverReview({
      action: "revise",
      content_id: id,
      label: "a",
      feedback: "清理脸部脏纹，保持原本五官",
      edit_mode: "local",
      mask_region: { x: 0.25, y: 0.15, width: 0.5, height: 0.45 },
      _dataDir: dir,
    })) as { ok: boolean; editMode?: string; review: { variants: Array<{ label: string; revision?: number }> } };

    expect(result.ok).toBe(true);
    expect(result.editMode).toBe("local");
    expect(reviseMock).not.toHaveBeenCalled();
    expect(relayMock).toHaveBeenCalledTimes(1);
    const call = relayMock.mock.calls[0][0];
    expect(call.referenceImagePaths?.[0]).toBe(sourcePath);
    expect(call.maskPath).toContain("autocrew-cover-local-edit-");
    expect(call.prompt).toContain("change only the transparent selected region");
    expect(call.prompt).toContain("清理脸部脏纹");
    expect(result.review.variants.find((variant) => variant.label === "a")?.revision).toBe(2);
    await expect(fs.access(path.dirname(call.maskPath!))).rejects.toThrow();
  });

  it("局部修脸会保留真实身份锚点，并优先带入用户选中的生成生活照", async () => {
    await switchToRelay();
    const refsDir = path.join(dir, "covers", "templates");
    const portraitsDir = path.join(dir, "covers", "portraits");
    await Promise.all([
      fs.mkdir(refsDir, { recursive: true }),
      fs.mkdir(portraitsDir, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(refsDir, "current.jpg"), Buffer.from("identity-photo")),
      fs.writeFile(path.join(refsDir, "studio.jpg"), Buffer.from("editorial-photo")),
      fs.writeFile(path.join(portraitsDir, "lifestyle.png"), Buffer.from("generated-lifestyle")),
      fs.writeFile(
        path.join(dir, "cover-style.json"),
        JSON.stringify({
          version: 1,
          name: "个人 IP 封面",
          referenceImages: [
            { filename: "current.jpg", role: "identity", priority: 0 },
            { filename: "studio.jpg", role: "editorial", priority: 10 },
            { filename: "lifestyle.png", role: "generated", priority: 20 },
          ],
          visualRules: [],
          identityRules: [],
          typographyRules: [],
          layoutRules: [],
          avoid: [],
          qualityGates: [],
        }),
      ),
    ]);
    const id = await seedContent();
    await createCandidates(id);
    const review = await getCoverReview(id, dir);
    const sourcePath = review!.variants.find((variant) => variant.label === "a")!.imagePaths["3:4"]!;
    const rows = Array.from({ length: 16 }, () => Buffer.alloc(12 * 4, 180));
    await fs.writeFile(sourcePath, encodePng(12, 16, 4, rows));
    relayMock.mockClear();

    const result = await executeCoverReview({
      action: "revise",
      content_id: id,
      label: "a",
      feedback: "使用选中的生活照表情",
      edit_mode: "local",
      mask_region: { x: 0.25, y: 0.15, width: 0.5, height: 0.45 },
      _dataDir: dir,
    });

    expect(result.ok).toBe(true);
    expect(relayMock.mock.calls[0][0].referenceImagePaths?.map((item) => path.basename(item))).toEqual([
      path.basename(sourcePath),
      "current.jpg",
      "lifestyle.png",
    ]);
  });

  it("不支持 mask 的 provider 对局部修订 fail closed，不偷偷降级整图重画", async () => {
    const id = await seedContent();
    await createCandidates(id);
    reviseMock.mockClear();
    genMock.mockClear();
    const result = (await executeCoverReview({
      action: "revise",
      content_id: id,
      label: "a",
      feedback: "只修脸",
      edit_mode: "local",
      mask_region: { x: 0.25, y: 0.15, width: 0.5, height: 0.45 },
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("已拒绝整张重画");
    expect(reviseMock).not.toHaveBeenCalled();
    expect(genMock).not.toHaveBeenCalled();
  });

  it("relay 选中但未配置 → 明确报错指向 设置·发布", async () => {
    await fs.writeFile(path.join(dir, "cover.json"), JSON.stringify({ provider: "relay" }), "utf-8");
    const id = await seedContent();
    const r = (await executeCoverReview({ action: "create_candidates", content_id: id, _dataDir: dir })) as {
      ok: boolean;
      error: string;
      hint?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("中转");
    expect(r.hint).toContain("设置·发布");
  });

  it("横屏主比例(V5.6.1):ratio=16:9 → 候选按 16:9 出,primaryRatio 落库,approve 取横屏成图", async () => {
    await switchToRelay();
    const id = await seedContent("draft_ready", "bilibili");
    const r = (await executeCoverReview({
      action: "create_candidates",
      content_id: id,
      ratio: "16:9",
      _dataDir: dir,
    })) as {
      ok: boolean;
      review: { primaryRatio?: string; variants: Array<{ label: string; imagePaths: Record<string, string> }> };
    };
    expect(r.ok).toBe(true);
    expect(r.review.primaryRatio).toBe("16:9");
    expect(relayMock.mock.calls[0][0].targetAspect).toBe("16:9");
    const a = r.review.variants.find((v) => v.label === "a")!;
    expect(a.imagePaths["16:9"]).toContain("-16x9");

    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    const review = await getCoverReview(id, dir);
    expect(review!.approvedImagePath).toBe(review!.variants.find((v) => v.label === "a")!.imagePaths["16:9"]);
  });

  it("公众号主比例 2.35:1(relay):ratio=2.35:1 → 候选按 2.35:1 出,primaryRatio 落库,不被强制回 3:4", async () => {
    await switchToRelay();
    const id = await seedContent("draft_ready", "wechat_mp");
    const r = (await executeCoverReview({
      action: "create_candidates",
      content_id: id,
      ratio: "2.35:1",
      _dataDir: dir,
    })) as {
      ok: boolean;
      review: { primaryRatio?: string; variants: Array<{ label: string; imagePaths: Record<string, string> }> };
    };
    expect(r.ok).toBe(true);
    expect(r.review.primaryRatio).toBe("2.35:1");
    expect(relayMock.mock.calls[0][0].targetAspect).toBe("2.35:1");
    expect(r.review.variants.find((v) => v.label === "a")!.imagePaths["2.35:1"]).toContain("2.35x1");
  });

  it("公众号主比例 2.35:1(gemini):走 wide-crop 桥,不误入原生 2.35:1 分支", async () => {
    // beforeEach 默认 provider=gemini
    const id = await seedContent("draft_ready", "wechat_mp");
    wideMock.mockResolvedValue({ ok: true, path: path.join(dir, "cover-wide.png"), ratioUsed: "21:9", cropped: true });
    const r = (await executeCoverReview({
      action: "create_candidates",
      content_id: id,
      ratio: "2.35:1",
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as { ok: boolean; review: { primaryRatio?: string } };
    expect(r.ok).toBe(true);
    expect(r.review.primaryRatio).toBe("2.35:1");
    expect(wideMock).toHaveBeenCalled();
    expect(genMock).not.toHaveBeenCalled();
  });

  it("platform_ratios 2.35:1 走中转直出(不经 21:9 桥/wide-crop)", async () => {
    await switchToRelay();
    const id = await seedContent("draft_ready", "wechat_mp");
    await executeCoverReview({ action: "create_candidates", content_id: id, _dataDir: dir });
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    relayMock.mockClear();

    const r = (await executeCoverReview({ action: "platform_ratios", content_id: id, _dataDir: dir })) as {
      ok: boolean;
      paths: Record<string, string>;
    };
    expect(r.ok).toBe(true);
    expect(r.paths["2.35:1"]).toContain("235x1");
    expect(wideMock).not.toHaveBeenCalled();
    expect(relayMock.mock.calls[0][0].targetAspect).toBe("2.35:1");
    const review = await getCoverReview(id, dir);
    expect(review!.variants.find((v) => v.label === "a")!.imagePaths["2.35:1"]).toContain("235x1");
    // 人机协同:适配比例在文件夹根留副本
    await expect(fs.access(path.join(dir, "contents", id, "封面-235x1.png"))).resolves.toBeUndefined();
  });

  it("个人 IP 的 4:3 适配锁定已批准母版，只把新增左右区域交给 mask outpaint", async () => {
    await switchToRelay();
    await fs.mkdir(path.join(dir, "covers", "templates"), { recursive: true });
    await fs.writeFile(path.join(dir, "covers", "templates", "me.png"), Buffer.from("identity"));
    const id = await seedContent("draft_ready", "douyin");
    await executeCoverReview({ action: "create_candidates", content_id: id, _dataDir: dir });
    await executeCoverReview({ action: "approve", content_id: id, label: "b", _dataDir: dir });
    const review = await getCoverReview(id, dir);
    const masterPath = review!.variants.find((variant) => variant.label === "b")!.imagePaths["3:4"]!;
    const rows = Array.from({ length: 12 }, () => Buffer.alloc(9 * 3, 128));
    await fs.writeFile(masterPath, encodePng(9, 12, 3, rows));
    relayMock.mockClear();

    const result = (await executeCoverReview({
      action: "platform_ratios",
      content_id: id,
      ratios: ["4:3"],
      _dataDir: dir,
    })) as { ok: boolean; paths: Record<string, string> };

    expect(result.ok).toBe(true);
    const call = relayMock.mock.calls[0][0];
    expect(call.targetAspect).toBe("4:3");
    expect(call.maskPath).toContain("identity-locked-mask.png");
    expect(call.referenceImagePaths[0]).toContain("identity-locked-canvas.png");
    expect(call.prompt).toContain("preserve every opaque master pixel exactly");
    await expect(fs.access(path.dirname(call.maskPath))).rejects.toThrow();
  });
});

describe("platform_ratios", () => {
  it("公众号默认出 2.35:1,存进选用方案 imagePaths", async () => {
    const id = await seedContent("draft_ready", "wechat_mp");
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    wideMock.mockResolvedValueOnce({
      ok: true,
      path: path.join(dir, "cover-a-r1-235x1.png"),
      ratioUsed: "21:9",
      cropped: true,
    });

    const r = (await executeCoverReview({
      action: "platform_ratios",
      content_id: id,
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as {
      ok: boolean;
      paths: Record<string, string>;
    };
    expect(r.ok).toBe(true);
    expect(r.paths["2.35:1"]).toContain("235x1");
    const review = await getCoverReview(id, dir);
    const a = review!.variants.find((v) => v.label === "a")!;
    expect(a.imagePaths["2.35:1"]).toContain("235x1");
  });

  it("未选用先跑比例 → 明确报错", async () => {
    const id = await seedContent();
    await createCandidates(id);
    const r = (await executeCoverReview({
      action: "platform_ratios",
      content_id: id,
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("approve");
  });

  it("16:9/4:3 适配不再过 Pro 门:gemini 原生比例直出,同 prompt 重渲染", async () => {
    const id = await seedContent("draft_ready", "bilibili");
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    genMock.mockClear();

    const r = (await executeCoverReview({
      action: "platform_ratios",
      content_id: id,
      ratios: ["16:9", "4:3"],
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as { ok: boolean; paths: Record<string, string>; upgradeHint?: string };
    expect(r.ok).toBe(true);
    expect(r.upgradeHint).toBeUndefined();
    expect(r.paths["16:9"]).toContain("-16x9");
    expect(r.paths["4:3"]).toContain("-4x3");
    expect(genMock.mock.calls.map((c) => c[0].aspectRatio)).toEqual(["16:9", "4:3"]);
  });

  it("legacy generate_ratios 委托新链路(MCP 兼容,免 Pro)", async () => {
    const id = await seedContent();
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "b", _dataDir: dir });
    const r = (await executeCoverReview({
      action: "generate_ratios",
      content_id: id,
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as {
      ok: boolean;
      paths: Record<string, string>;
      upgradeHint?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.upgradeHint).toBeUndefined();
    expect(Object.keys(r.paths).sort()).toEqual(["16:9", "4:3"]);
  });

  it("请求里剔除主比例:只请求 primary → 明确报错", async () => {
    const id = await seedContent();
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    const r = (await executeCoverReview({
      action: "platform_ratios",
      content_id: id,
      ratios: ["3:4"],
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as {
      ok: boolean;
      error: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("主比例");
  });

  it("裁切降级 warning 透出", async () => {
    const id = await seedContent("draft_ready", "wechat_mp");
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    wideMock.mockResolvedValueOnce({
      ok: true,
      path: path.join(dir, "x-235x1.jpg"),
      ratioUsed: "21:9",
      cropped: false,
      warning: "裁切失败(非 PNG),交付未裁切的 21:9 原图",
    });
    const r = (await executeCoverReview({
      action: "platform_ratios",
      content_id: id,
      _dataDir: dir,
      _geminiApiKey: "k",
    })) as { ok: boolean; warnings?: string[] };
    expect(r.ok).toBe(true);
    expect(r.warnings![0]).toContain("裁切失败");
  });
});

// ─── 认领令牌门与评审单 CAS（P3 spec §6.1，codex 评审 #11） ───────────────────

describe("认领令牌门", () => {
  it("别的宿主握着活租约时，出图/修订/批准全被拒并说得出持有者", async () => {
    const id = await seedContent();
    await claimContent(id, "cover", "codex", dir);
    for (const action of ["create_candidates", "revise", "approve", "platform_ratios"]) {
      const r = (await executeCoverReview({
        action,
        content_id: id,
        label: "a",
        feedback: "换个配色",
        _dataDir: dir,
        _geminiApiKey: "k",
        _host: "claude-code",
      })) as { ok: boolean; error: string };
      expect(r.ok).toBe(false);
      expect(r.error).toContain("codex");
    }
    expect(await getCoverReview(id, dir)).toBeNull();
  });

  it("没人认领 → 直接出图并自动认领封面师桌（软门）", async () => {
    const id = await seedContent();
    const r = (await createCandidates(id)) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect((await getContent(id, dir))!.claim).toMatchObject({ employee: "cover", host: "local-user" });
  });

  it("get 是只读的：别人认领着也照读不误", async () => {
    const id = await seedContent();
    await createCandidates(id);
    await claimContent(id, "cover", "codex", dir);
    const r = (await executeCoverReview({ action: "get", content_id: id, _dataDir: dir, _host: "claude-code" })) as {
      ok: boolean;
    };
    expect(r.ok).toBe(true);
  });
});

describe("评审单 CAS", () => {
  it("出图那 90 秒里评审单被换过 → 拒绝并让人重新 get，不覆盖对方那一轮", async () => {
    const id = await seedContent();
    await createCandidates(id); // r1 落库
    // 出图期间另一方写了新一轮候选：用一次真实保存模拟
    genMock.mockImplementation(async (opts) => {
      const p = `${opts.outputPath}.png`;
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, Buffer.from("png-bytes"));
      const current = await getCoverReview(id, dir);
      if (current && maxRevisionOf(current) < 9) {
        await saveCoverReview(
          id,
          { ...current, variants: current.variants.map((v) => ({ ...v, revision: 9 })) },
          dir,
        );
      }
      return { ok: true, imagePath: p, model: "mock-model" };
    });
    const r = (await createCandidates(id)) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("重新 get");
    // 对方那一轮还在盘上，没被这次结果盖掉
    expect(maxRevisionOf((await getCoverReview(id, dir))!)).toBe(9);
  });
});

function maxRevisionOf(review: { variants: Array<{ revision?: number }> }): number {
  return review.variants.reduce((m, v) => Math.max(m, v.revision ?? 1), 0);
}
