/**
 * designer.test.ts — 封面设计师:submit 工具校验、自纠通道、修订模式。全 mock 零网络。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { designCoverPlan, reviseCoverDesign, type CoverDesign } from "./designer.js";
import type { runLoop } from "../../engine/loop.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-designer-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "sk-test" }), "utf-8");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const LONG_PROMPT =
  "Vertical 3:4 portrait orientation cover image. A handmade paper evidence scene with tactile labels, " +
  'the Chinese text "封面大字" printed on a physical warning seal. No watermarks, no logos, no URLs.';

const STYLE = { A: "纸上证物", B: "荒诞静物", C: "实体警示牌" } as const;
const CONCEPT = {
  A: "把关键合同做成一件被扣留的证物",
  B: "把数据交换变成一台实体租金表",
  C: "把标题做成横跨现场的警示封条",
} as const;
const MEDIUM = { A: "documentary photography", B: "surreal still life", C: "cut-paper collage" } as const;
const PALETTE = {
  A: "paper white and evidence red",
  B: "warm cream and cobalt",
  C: "high-key white and vermilion",
} as const;

const goodDesign = (label: "A" | "B" | "C"): Record<string, unknown> => ({
  label,
  style: STYLE[label],
  creativeConcept: CONCEPT[label],
  visualMedium: MEDIUM[label],
  palette: PALETTE[label],
  titleText: "封面大字",
  imagePrompt: `${LONG_PROMPT} Candidate ${label} uses ${MEDIUM[label]} and ${PALETTE[label]}.`,
  layoutHint: "标题上 1/3,主体中下",
  designReason: "冲突感标题+电影光影,能停住滑动",
});

interface CapturedOpts {
  systemPrompt: string;
  userMessage: string;
}

/** mock loop:依次把 payloads 喂给指定工具,记录 execute 返回与 opts */
function mockLoop(
  toolName: string,
  payloads: Array<Record<string, unknown>>,
  execResults: string[] = [],
  captured?: CapturedOpts[],
): typeof runLoop {
  return (async (
    _config: unknown,
    opts: {
      systemPrompt: string;
      userMessage: string;
      tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }>;
    },
  ) => {
    captured?.push({ systemPrompt: opts.systemPrompt, userMessage: opts.userMessage });
    const tool = opts.tools.find((t) => t.name === toolName);
    if (tool) {
      for (const p of payloads) execResults.push(String(await tool.execute(p)));
    }
    return { stopReason: "tool", turns: 1, totalTokens: 321, finalText: "" };
  }) as unknown as typeof runLoop;
}

describe("designCoverPlan", () => {
  it("平铺分三次提交(杜绝嵌套 JSON 双重转义翻车)→ 收齐返回 A/B/C,硬规则进 system prompt", async () => {
    const captured: CapturedOpts[] = [];
    const execResults: string[] = [];
    const { designs, tokensUsed } = await designCoverPlan(
      { title: "AI 写码的账怎么算", body: "正文……", platform: "wechat_mp", hasReferencePhotos: true },
      dir,
      {
        runLoopImpl: mockLoop(
          "submit_cover_design",
          [goodDesign("A"), goodDesign("B"), goodDesign("C")],
          execResults,
          captured,
        ),
      },
    );
    expect(designs.map((d) => d.label)).toEqual(["A", "B", "C"]);
    expect(tokensUsed).toBe(321);
    expect(execResults[0]).toContain("还差 B/C");
    expect(execResults[2]).toContain("反模板差异校验");
    expect(captured[0].systemPrompt).toContain("3:4");
    expect(captured[0].systemPrompt).toContain("水印");
    expect(captured[0].systemPrompt).toContain("陈词滥调");
    expect(captured[0].systemPrompt).toContain("不能交 cinematic/minimalist/bold-impact");
    expect(captured[0].systemPrompt).toContain("submit_cover_design");
    expect(captured[0].userMessage).toContain("AI 写码的账怎么算");
    expect(captured[0].userMessage).toContain("形象照");
  });

  it("横屏 16:9(V5.6.1):系统提示切横版方向词与横屏构图,用户消息带比例", async () => {
    const captured: CapturedOpts[] = [];
    await designCoverPlan({ title: "t", body: "b", hasReferencePhotos: false, targetAspect: "16:9" }, dir, {
      runLoopImpl: mockLoop("submit_cover_design", [goodDesign("A"), goodDesign("B"), goodDesign("C")], [], captured),
    });
    expect(captured[0].systemPrompt).toContain("16:9");
    expect(captured[0].systemPrompt).toContain("横版");
    expect(captured[0].systemPrompt).not.toContain("Vertical 3:4");
    expect(captured[0].userMessage).toContain("16:9(横屏)");
  });

  it("把个人 IP 的锁脸、颗粒和图层标准交给设计师", async () => {
    const captured: CapturedOpts[] = [];
    await designCoverPlan(
      {
        title: "一起搞懂 Agent Harness",
        body: "这一年 AI 如何改变工作与生活",
        hasReferencePhotos: true,
        styleProfile: {
          version: 1,
          name: "人物清晰的编辑封面",
          visualRules: ["文字保留印刷颗粒，人物低颗粒"],
          identityRules: ["生活照负责锁脸和眼镜"],
          typographyRules: ["粗体标题"],
          layoutRules: ["背景 → 主标题 → 完全不透明人物 → 副标题"],
          avoid: ["程序员刻板印象"],
          qualityGates: ["标题不穿过人物"],
        },
      },
      dir,
      {
        runLoopImpl: mockLoop("submit_cover_design", [goodDesign("A"), goodDesign("B"), goodDesign("C")], [], captured),
      },
    );
    expect(captured[0].userMessage).toContain("生活照负责锁脸和眼镜");
    expect(captured[0].userMessage).toContain("完全不透明人物");
    expect(captured[0].userMessage).toContain("文字保留印刷颗粒，人物低颗粒");
  });

  it("titleText 超长/无中文 → 工具打回自纠;修正后通过;同 label 重交以最后一次为准", async () => {
    const execResults: string[] = [];
    const { designs } = await designCoverPlan({ title: "t", body: "b", hasReferencePhotos: false }, dir, {
      runLoopImpl: mockLoop(
        "submit_cover_design",
        [
          { ...goodDesign("A"), titleText: "这个标题实在是太长了完全放不进封面" },
          goodDesign("A"),
          goodDesign("B"),
          goodDesign("C"),
        ],
        execResults,
      ),
    });
    expect(execResults[0]).toContain("Error");
    expect(execResults[0]).toContain("2-12");
    expect(execResults[1]).toContain("已收到方案 A");
    expect(designs).toHaveLength(3);
  });

  it("imagePrompt 太短 → 打回;方案未收齐 → 明确报错(带已收清单)", async () => {
    const execResults: string[] = [];
    await expect(
      designCoverPlan({ title: "t", body: "b", hasReferencePhotos: false }, dir, {
        runLoopImpl: mockLoop(
          "submit_cover_design",
          [{ ...goodDesign("A"), imagePrompt: "too short" }, goodDesign("B")],
          execResults,
        ),
      }),
    ).rejects.toThrow(/方案未收齐/);
    expect(execResults[0]).toContain("80");
  });

  it("固定风格名会被打回,三张全是屏幕/服务器也无法过差异校验", async () => {
    const execResults: string[] = [];
    const generic = { ...goodDesign("A"), style: "cinematic" };
    const cliché = (label: "A" | "B" | "C") => ({
      ...goodDesign(label),
      imagePrompt: `${LONG_PROMPT} A laptop screen beside a server rack with a glowing neural network, candidate ${label}.`,
    });
    const { designs } = await designCoverPlan(
      { title: "数据正在喂模型", body: "合同被上传", hasReferencePhotos: false },
      dir,
      {
        runLoopImpl: mockLoop(
          "submit_cover_design",
          [generic, cliché("A"), cliché("B"), cliché("C"), goodDesign("C")],
          execResults,
        ),
      },
    );
    expect(execResults[0]).toContain("模板名");
    expect(execResults[3]).toContain("陈词滥调");
    expect(designs).toHaveLength(3);
  });

  it("不会把 No server rooms 等否定约束误判成真的使用了科技陈词滥调", async () => {
    const execResults: string[] = [];
    const payloads = (["A", "B", "C"] as const).map((label) => ({
      ...goodDesign(label),
      imagePrompt: `${LONG_PROMPT} No screens, no server racks, no holograms, no neural network imagery.`,
    }));
    const { designs } = await designCoverPlan(
      { title: "数据主权", body: "合同上传后无法撤回", hasReferencePhotos: false },
      dir,
      { runLoopImpl: mockLoop("submit_cover_design", payloads, execResults) },
    );
    expect(execResults[2]).toContain("反模板差异校验");
    expect(designs).toHaveLength(3);
  });
});

describe("reviseCoverDesign", () => {
  const previous: CoverDesign = {
    label: "B",
    style: "纸上证物",
    creativeConcept: CONCEPT.B,
    visualMedium: MEDIUM.B,
    palette: PALETTE.B,
    imagePrompt: LONG_PROMPT,
    titleText: "旧的大字",
    layoutHint: "居中",
    designReason: "原方案",
  };

  it("按反馈修订 → 返回单方案,label 继承原方案,反馈进 user prompt", async () => {
    const captured: CapturedOpts[] = [];
    const revised = await reviseCoverDesign(
      { previous, feedback: "标题太温了,换更狠的;背景加霓虹", title: "t", hasReferencePhotos: false },
      dir,
      {
        runLoopImpl: mockLoop(
          "submit_cover_revision",
          [
            {
              style: "撕毁的租金收据",
              creativeConcept: "把旧收据撕开后露出数据流向",
              visualMedium: "paper collage",
              palette: "warm paper and warning red",
              titleText: "狠的大字",
              imagePrompt: LONG_PROMPT,
              layoutHint: "居中偏上",
              designReason: "按反馈加强冲击",
            },
          ],
          [],
          captured,
        ),
      },
    );
    expect(revised.label).toBe("B");
    expect(revised.titleText).toBe("狠的大字");
    expect(captured[0].userMessage).toContain("标题太温了");
    expect(captured[0].userMessage).toContain("旧的大字");
  });

  it("修订时继续携带个人封面标准，避免改一处后身份与图层漂移", async () => {
    const captured: CapturedOpts[] = [];
    await reviseCoverDesign(
      {
        previous,
        feedback: "HARNESS 在人物前面",
        title: "Agent Harness",
        hasReferencePhotos: true,
        styleProfile: {
          version: 1,
          name: "人物在前",
          visualRules: [],
          identityRules: ["必须像本人"],
          typographyRules: [],
          layoutRules: ["主标题在人物背后，人物完全不透明"],
          avoid: [],
          qualityGates: ["文字不能穿过脸"],
        },
      },
      dir,
      {
        runLoopImpl: mockLoop(
          "submit_cover_revision",
          [
            {
              style: "人物前景编辑封面",
              creativeConcept: "人物覆盖大字形成清晰纵深",
              visualMedium: "editorial portrait photography",
              palette: "red black and cyan",
              titleText: "搞懂Harness",
              imagePrompt: LONG_PROMPT,
              layoutHint: "人物完全不透明地位于标题前方",
              designReason: "修复图层关系",
            },
          ],
          [],
          captured,
        ),
      },
    );
    expect(captured[0].userMessage).toContain("主标题在人物背后");
    expect(captured[0].userMessage).toContain("HARNESS 在人物前面");
  });

  it("模型不提交 → 报错", async () => {
    await expect(
      reviseCoverDesign({ previous, feedback: "x", title: "t", hasReferencePhotos: false }, dir, {
        runLoopImpl: mockLoop("submit_cover_revision", []),
      }),
    ).rejects.toThrow(/未调用 submit_cover_revision/);
  });
});
