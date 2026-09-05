import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  coverStylePrompt,
  loadCoverStyleProfile,
  orderCoverReferencePhotos,
  saveCoverStyleProfile,
  selectCoverReferencePhotos,
  type CoverStyleProfile,
} from "./style-profile.js";

let dir: string;

const profile: CoverStyleProfile = {
  version: 1,
  name: "人物清晰的编辑封面",
  referenceImages: [
    { filename: "current.png", role: "identity", priority: 0 },
    { filename: "studio.jpg", role: "editorial", priority: 10 },
  ],
  visualRules: ["文字和背景允许印刷颗粒，人物保持低颗粒真实摄影"],
  identityRules: ["当前生活照负责五官与眼镜，棚拍照只补气质"],
  typographyRules: ["粗体无衬线，缩略图可读"],
  layoutRules: ["背景 → 主标题 → 完全不透明人物 → 副标题"],
  avoid: ["程序员宅男刻板印象"],
  qualityGates: ["标题不穿过脸和身体"],
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-cover-style-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("cover style profile", () => {
  it("保存并读取个人封面标准", async () => {
    const target = await saveCoverStyleProfile(profile, dir);
    expect(target).toBe(path.join(dir, "cover-style.json"));
    expect(await loadCoverStyleProfile(dir)).toEqual(profile);
  });

  it("把人物、文字颗粒和图层约束变成 prompt", () => {
    const prompt = coverStylePrompt(profile);
    expect(prompt).toContain("当前生活照负责五官与眼镜");
    expect(prompt).toContain("文字和背景允许印刷颗粒");
    expect(prompt).toContain("完全不透明人物");
    expect(prompt).toContain("标题不穿过脸和身体");
  });

  it("按 profile 优先级排列参考图，身份照永远在 relay 前三张", () => {
    const ordered = orderCoverReferencePhotos(["/tmp/other.webp", "/tmp/studio.jpg", "/tmp/current.png"], profile);
    expect(ordered.map((item) => path.basename(item))).toEqual(["current.png", "studio.jpg", "other.webp"]);
  });

  it("最终封面只取一个已选 AI 姿态，并保留两张真实照片压住身份漂移", () => {
    const withGenerated: CoverStyleProfile = {
      ...profile,
      referenceImages: [
        ...(profile.referenceImages ?? []),
        { filename: "pose-a.png", role: "generated", priority: 20 },
        { filename: "pose-b.png", role: "generated", priority: 21 },
      ],
    };
    const selected = selectCoverReferencePhotos(
      ["/tmp/pose-b.png", "/tmp/studio.jpg", "/tmp/pose-a.png", "/tmp/current.png"],
      withGenerated,
    );
    expect(selected.map((item) => path.basename(item))).toEqual(["current.png", "studio.jpg", "pose-a.png"]);
  });
});
