/** 口吻参考入库（spec 2026-10-15 §16、§17）：创始人成片转写进范文库当 voice_ref，不当范文；voice_refs 优先用它 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importVoiceFiles, libraryVoiceRefs, voiceExcerpt } from "./voice.js";
import { exemplarVersionPath, putExemplar } from "./store.js";
import { previewExemplars, validatePins } from "./select.js";
import { executeDraft } from "../../tools/draft.js";

const HARNESS = Array.from("Harness").map((ch) => ch.codePointAt(0)).join("");
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const asr = (title: string, segs: string[]) => `# ${title}\n\n- Author: 哈姆雷鹿\n- URL: https://www.douyin.com/video/${Array.from(title).map((ch) => ch.codePointAt(0)).join("")}\n\n## Transcript\n\n${segs.map((s, i) => `**[00:${String(i * 15).padStart(2, "0")}]** ${s}`).join("\n\n")}\n`;

async function files(): Promise<string[]> {
  const src = path.join(dir, "src");
  await fs.mkdir(src, { recursive: true });
  const out = [];
  for (const [n, t] of [["B-1-agent-harness.md", asr("Harness", ["如果你现在用AI 还是在打开一个对话框", "那你用的可能还是2023年的方式"])], ["B-2-x.md", asr("二", ["第二篇"])], ["index.md", "# 索引"], ["bad.md", "# 没正文\n"]]) {
    await fs.writeFile(path.join(src, n), t);
    out.push(path.join(src, n));
  }
  return out;
}

describe("口吻参考入库", () => {
  it("中文文件名不再撞 id；有作品链接用作品 id，同一条视频来自另一个文件 → 拒（Codex 复审 #3）", async () => {
    const src = path.join(dir, "zh");
    await fs.mkdir(src, { recursive: true });
    const body = "\n\n## 全文\n\n**[00:00]** 说的话。\n";
    await fs.writeFile(path.join(src, "2026-10-15-咖啡.md"), `# 咖啡${body}`);
    await fs.writeFile(path.join(src, "2026-10-15-家具.md"), `# 家具${body}`);
    await fs.writeFile(path.join(src, "a.md"), `# A\n- 链接：https://www.douyin.com/video/123${body}`);
    await fs.writeFile(path.join(src, "b.md"), `# B\n- URL: https://www.douyin.com/video/123${body}`);
    const r = await importVoiceFiles([src], dir);
    const ok = r.filter((x) => x.outcome === "created").map((x) => x.id);
    expect(new Set(ok).size).toBe(3);
    expect(ok).toContain("voice-dy-123");
    expect(r.find((x) => x.file === "b.md")?.error).toContain("撞了 id");
  });

  it("目录导入：跳过 index.md；缺正文的拒；按内容幂等；kind=voice_ref", async () => {
    const [, , , ] = await files();
    const r = await importVoiceFiles([path.join(dir, "src")], dir);
    expect(r.map((x) => [x.file, x.outcome ?? x.error])).toEqual([["B-1-agent-harness.md", "created"], ["B-2-x.md", "created"], ["bad.md", expect.stringContaining("Transcript")]]);
    expect((await importVoiceFiles([path.join(dir, "src", "B-1-agent-harness.md")], dir))[0].outcome).toBe("unchanged");
  });

  it("不进范文预览、不能被锁成范文", async () => {
    await files();
    await importVoiceFiles([path.join(dir, "src")], dir);
    expect((await previewExemplars("ganhuo", undefined, dir)).entries).toEqual([]);
    expect(await validatePins([{ id: `voice-dy-${HARNESS}`, version: 1 }], "ganhuo", dir)).toContain("没有");
  });

  it("按时间戳整段节选；指纹不对的报进 errors；同一个 seed 每次取同样两篇", async () => {
    expect(voiceExcerpt("**[00:00]** 一二三\n\n**[00:15]** 四五六", 9)).toEqual({ text: "[00:00] 一二三", excerpted: true });
    await files();
    await importVoiceFiles([path.join(dir, "src")], dir);
    await putExemplar({ id: "voice-c", genre: "any", kind: "voice_ref", title: "C", text: asr("C", ["三"]) }, dir);
    const a = await libraryVoiceRefs("content-x", 2, 3000, dir);
    expect(a.refs).toHaveLength(2);
    expect((await libraryVoiceRefs("content-x", 2, 3000, dir)).refs.map((r) => r.id)).toEqual(a.refs.map((r) => r.id));
    await fs.appendFile(exemplarVersionPath("voice-c", 1, dir), "改");
    const b = await libraryVoiceRefs("seed", 3, 3000, dir);
    expect(b.errors).toEqual([expect.stringContaining("指纹对不上")]);
  });

  it("start：有成片转写就用它（标「创始人成片转写，不是范文」），不进 firsthand", async () => {
    await files();
    await importVoiceFiles([path.join(dir, "src")], dir);
    const s = await executeDraft({ action: "start", inspiration: "用了 AI 反而更忙", _dataDir: dir, _host: "claude-code", _session: "s1" }) as { context: Record<string, any> };
    expect(s.context.voice_refs).toMatchObject({ source: "library", label: "口吻参考：创始人成片转写，不是范文" });
    expect(s.context.voice_refs.refs).toHaveLength(2);
    expect(JSON.stringify(s.context.firsthand)).not.toContain("对话框");
  });
});
