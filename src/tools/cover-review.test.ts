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
import { saveContent, getContent, getCoverReview } from "../storage/local-store.js";

const planMock = vi.mocked(designCoverPlan);
const reviseMock = vi.mocked(reviseCoverDesign);
const genMock = vi.mocked(generateImage);
const relayMock = vi.mocked(generateCoverViaRelay);
const wideMock = vi.mocked(generateWideCover);

let dir: string;

const LONG_PROMPT = "Vertical 3:4 portrait orientation cover image. Cinematic photo-realism with bold Chinese title text overlay.";

const design = (label: "A" | "B" | "C", extra?: Partial<CoverDesign>): CoverDesign => ({
  label,
  style: "cinematic",
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
    JSON.stringify({ wechatMp: { imageApiKey: "sk-relay", imageBaseUrl: "https://relay.test/v1", imageModel: "gpt-image-2" } }),
    "utf-8",
  );
}

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function seedContent(status = "draft_ready", platform = "wechat_mp"): Promise<string> {
  const c = await saveContent(
    { title: "AI 写码的账", body: "正文内容", platform, status: status as never, tags: [], hashtags: [] },
    dir,
  );
  return c.id;
}

async function createCandidates(contentId: string): Promise<Record<string, unknown>> {
  return (await executeCoverReview({ action: "create_candidates", content_id: contentId, _dataDir: dir, _geminiApiKey: "k" })) as Record<string, unknown>;
}

describe("create_candidates", () => {
  it("设计师方案 → 3 张候选,r1 文件名,designSource=designer", async () => {
    const id = await seedContent();
    const r = (await createCandidates(id)) as { ok: boolean; designSource: string; review: { variants: Array<{ imagePaths: Record<string, string>; revision?: number; designReason?: string }> } };
    expect(r.ok).toBe(true);
    expect(r.designSource).toBe("designer");
    expect(r.review.variants).toHaveLength(3);
    for (const v of r.review.variants) {
      expect(v.revision).toBe(1);
      expect(v.imagePaths["3:4"]).toContain("-r1");
    }
  });

  it("设计师失败 → 降级规则版(designSource=rules),候选照出", async () => {
    planMock.mockRejectedValueOnce(new Error("engine down"));
    const id = await seedContent();
    const r = (await createCandidates(id)) as { ok: boolean; designSource: string; review: { variants: unknown[] } };
    expect(r.ok).toBe(true);
    expect(r.designSource).toBe("rules");
    expect(r.review.variants).toHaveLength(3);
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

  it("publish_ready 稿件选封面不被倒拨回 approved", async () => {
    const id = await seedContent("publish_ready");
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    const content = await getContent(id, dir);
    expect(content!.status).toBe("publish_ready");
  });

  it("draft_ready 稿件选封面 → 正常推进到 approved", async () => {
    const id = await seedContent("draft_ready");
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    const content = await getContent(id, dir);
    expect(content!.status).toBe("approved");
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

    const r = (await executeCoverReview({ action: "revise", content_id: id, label: "a", feedback: "标题太温", _dataDir: dir, _geminiApiKey: "k" })) as {
      ok: boolean;
      revision: number;
      review: { status: string; approvedLabel?: string; feedback?: Array<{ label: string; note: string; prevPrompt?: string }>; variants: Array<{ label: string; titleText?: string; revision?: number; imagePaths: Record<string, string> }> };
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

  it("缺 feedback → 明确报错", async () => {
    const id = await seedContent();
    await createCandidates(id);
    const r = (await executeCoverReview({ action: "revise", content_id: id, label: "a", _dataDir: dir, _geminiApiKey: "k" })) as { ok: boolean; error: string };
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
      return { ok: true, imagePath: p, model: "gpt-image-2", warning: "中转不支持参考图(/images/edits),本次未带人物形象" };
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
    const r = (await executeCoverReview({ action: "create_candidates", content_id: id, ratio: "16:9", _dataDir: dir })) as {
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
});

describe("platform_ratios", () => {
  it("公众号默认出 2.35:1,存进选用方案 imagePaths", async () => {
    const id = await seedContent("draft_ready", "wechat_mp");
    await createCandidates(id);
    await executeCoverReview({ action: "approve", content_id: id, label: "a", _dataDir: dir });
    wideMock.mockResolvedValueOnce({ ok: true, path: path.join(dir, "cover-a-r1-235x1.png"), ratioUsed: "21:9", cropped: true });

    const r = (await executeCoverReview({ action: "platform_ratios", content_id: id, _dataDir: dir, _geminiApiKey: "k" })) as {
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
    const r = (await executeCoverReview({ action: "platform_ratios", content_id: id, _dataDir: dir, _geminiApiKey: "k" })) as { ok: boolean; error: string };
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
    const r = (await executeCoverReview({ action: "generate_ratios", content_id: id, _dataDir: dir, _geminiApiKey: "k" })) as {
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
    const r = (await executeCoverReview({ action: "platform_ratios", content_id: id, ratios: ["3:4"], _dataDir: dir, _geminiApiKey: "k" })) as {
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
    wideMock.mockResolvedValueOnce({ ok: true, path: path.join(dir, "x-235x1.jpg"), ratioUsed: "21:9", cropped: false, warning: "裁切失败(非 PNG),交付未裁切的 21:9 原图" });
    const r = (await executeCoverReview({ action: "platform_ratios", content_id: id, _dataDir: dir, _geminiApiKey: "k" })) as { ok: boolean; warnings?: string[] };
    expect(r.ok).toBe(true);
    expect(r.warnings![0]).toContain("裁切失败");
  });
});
