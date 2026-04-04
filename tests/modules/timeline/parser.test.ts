import { describe, it, expect } from "vitest";
import { parseMarkedScript, type ParseOptions } from "../../../src/modules/timeline/parser.js";

const defaults: ParseOptions = {
  contentId: "test-001",
  preset: "knowledge-explainer",
  aspectRatio: "9:16",
};

describe("parseMarkedScript", () => {
  it("parses a simple marked script into correct timeline structure", () => {
    const script = `
这是第一段文案介绍
[card:comparison-table title="对比" rows="A:好:贵,B:便宜:差"]

这是第二段文案
[broll:城市夜景霓虹灯]

这是第三段文案
    `.trim();

    const timeline = parseMarkedScript(script, defaults);

    expect(timeline.version).toBe("2.0");
    expect(timeline.contentId).toBe("test-001");
    expect(timeline.preset).toBe("knowledge-explainer");
    expect(timeline.aspectRatio).toBe("9:16");
    expect(timeline.subtitle).toEqual({
      template: "modern-outline",
      position: "bottom",
    });

    // 3 TTS segments
    expect(timeline.tracks.tts).toHaveLength(3);
    expect(timeline.tracks.tts[0].id).toBe("tts-001");
    expect(timeline.tracks.tts[1].id).toBe("tts-002");
    expect(timeline.tracks.tts[2].id).toBe("tts-003");

    // 2 visual segments (card + broll)
    expect(timeline.tracks.visual).toHaveLength(2);
    expect(timeline.tracks.visual[0].type).toBe("card");
    expect(timeline.tracks.visual[1].type).toBe("broll");

    // Visual IDs
    expect(timeline.tracks.visual[0].id).toBe("vis-001");
    expect(timeline.tracks.visual[1].id).toBe("vis-002");
  });

  it("parses card data attributes correctly (rows, items, title)", () => {
    const script = `
介绍段落
[card:comparison-table title="产品对比" rows="苹果:好看:贵,安卓:便宜:丑"]
    `.trim();

    const timeline = parseMarkedScript(script, defaults);
    const card = timeline.tracks.visual[0];

    expect(card.template).toBe("comparison-table");
    expect(card.data).toEqual({
      title: "产品对比",
      rows: [
        { name: "苹果", pros: "好看", cons: "贵" },
        { name: "安卓", pros: "便宜", cons: "丑" },
      ],
    });
    expect(card.opacity).toBe(0.85);
  });

  it("parses card items attribute", () => {
    const script = `
要点介绍
[card:key-points items="观点一,观点二,观点三"]
    `.trim();

    const timeline = parseMarkedScript(script, defaults);
    const card = timeline.tracks.visual[0];

    expect(card.data).toEqual({
      items: ["观点一", "观点二", "观点三"],
    });
  });

  it("parses broll with span=2 linking to multiple TTS segments", () => {
    const script = `
第一段话
[broll:办公室场景]

第二段话
[broll:办公画面]

第三段话
[broll:城市夜景 span=2]
    `.trim();

    const timeline = parseMarkedScript(script, defaults);

    expect(timeline.tracks.tts).toHaveLength(3);

    const broll1 = timeline.tracks.visual[0];
    expect(broll1.linkedTts).toEqual(["tts-001"]);

    const broll3 = timeline.tracks.visual[2];
    expect(broll3.prompt).toBe("城市夜景");
    expect(broll3.linkedTts).toEqual(["tts-002", "tts-003"]);
  });

  it("handles script with no markup — single TTS, no visuals", () => {
    const script = "这是一段纯文本没有任何标记";
    const timeline = parseMarkedScript(script, defaults);

    expect(timeline.tracks.tts).toHaveLength(1);
    expect(timeline.tracks.tts[0].text).toBe("这是一段纯文本没有任何标记");
    expect(timeline.tracks.visual).toHaveLength(0);
  });

  it("estimates Chinese text duration correctly (~4 chars/sec)", () => {
    // 8 Chinese chars → 8/4 = 2.0s
    const script = "八个中文来测试吧";
    const timeline = parseMarkedScript(script, defaults);

    expect(timeline.tracks.tts[0].estimatedDuration).toBe(2);
  });

  it("skips empty lines without creating extra segments", () => {
    const script = `
第一段

第二段


第三段
    `.trim();

    const timeline = parseMarkedScript(script, defaults);

    // Empty lines between text just continue the text buffer — but here
    // there are no markup lines, so all non-empty lines become one TTS
    expect(timeline.tracks.tts).toHaveLength(1);
    expect(timeline.tracks.tts[0].text).toBe("第一段\n第二段\n第三段");
  });

  it("assigns card to layer 1 when layer 0 already taken by broll", () => {
    const script = `
一段文案
[broll:画面描述]
[card:key-points items="项目一,项目二"]
    `.trim();

    const timeline = parseMarkedScript(script, defaults);

    const broll = timeline.tracks.visual[0];
    const card = timeline.tracks.visual[1];

    expect(broll.layer).toBe(0);
    expect(broll.linkedTts).toEqual(["tts-001"]);
    expect(card.layer).toBe(1);
    expect(card.linkedTts).toEqual(["tts-001"]);
  });

  it("calculates start times sequentially", () => {
    const script = `
八个中文来测试吧
[broll:场景一]

八个中文来测试吧
[broll:场景二]
    `.trim();

    const timeline = parseMarkedScript(script, defaults);

    expect(timeline.tracks.tts[0].start).toBe(0);
    // 8 chars / 4 = 2.0s
    expect(timeline.tracks.tts[1].start).toBe(2);
  });

  it("sets default segment status to pending and asset to null", () => {
    const script = `
测试文案
[broll:测试画面]
    `.trim();

    const timeline = parseMarkedScript(script, defaults);

    for (const tts of timeline.tracks.tts) {
      expect(tts.status).toBe("pending");
      expect(tts.asset).toBeNull();
    }
    for (const vis of timeline.tracks.visual) {
      expect(vis.status).toBe("pending");
      expect(vis.asset).toBeNull();
    }
    expect(timeline.tracks.subtitle.status).toBe("pending");
    expect(timeline.tracks.subtitle.asset).toBeNull();
  });

  it("handles consecutive text lines as a single TTS segment", () => {
    const script = `
第一行文案
第二行文案
第三行文案
[broll:综合画面]
    `.trim();

    const timeline = parseMarkedScript(script, defaults);

    expect(timeline.tracks.tts).toHaveLength(1);
    expect(timeline.tracks.tts[0].text).toBe(
      "第一行文案\n第二行文案\n第三行文案"
    );
  });

  it("handles mixed Chinese and English text duration", () => {
    // 4 Chinese + "hello" (5 non-Chinese letters)
    // 4/4 + 5/15 = 1 + 0.333 ≈ 1.33
    const script = "四个中文hello";
    const timeline = parseMarkedScript(script, defaults);

    expect(timeline.tracks.tts[0].estimatedDuration).toBeCloseTo(1.33, 1);
  });

  it("parses card steps attribute", () => {
    const script = `
教程段落
[card:flow-chart steps="第一步,第二步,第三步"]
    `.trim();

    const timeline = parseMarkedScript(script, defaults);
    const card = timeline.tracks.visual[0];

    expect(card.data).toEqual({
      steps: ["第一步", "第二步", "第三步"],
    });
  });

  it("span exceeding available TTS clamps to available count", () => {
    const script = `
唯一一段
[broll:画面 span=5]
    `.trim();

    const timeline = parseMarkedScript(script, defaults);
    const broll = timeline.tracks.visual[0];

    expect(broll.linkedTts).toEqual(["tts-001"]);
  });
});
