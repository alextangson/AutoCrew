/** 范文库（spec 2026-10-15 §2、§10、§15.5、§15.10、§15.16）：存储、导入、按体裁预览、写法锁版 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exemplarVersionPath, putExemplar, readExemplarManifest, readExemplarText } from "./store.js";
import { importExemplarDir, parseExemplarFile } from "./import.js";
import { missingExemplarRefs, previewExemplars, PREVIEW_BUDGET_CHARS, validatePins } from "./select.js";
import { currentMethod, lockedMethod, methodSection, pinMethod } from "./method.js";
import { saveContent } from "../../storage/local-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "exemplar-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const bench = (title: string, extra = "", body = "正文。") => `# ${title}\n\n- 作者：某某（对标）\n${extra}\n\n## 全文\n\n**[00:00]** ${body}\n\n## 批注\n\n1. 第一条\n`;

describe("存储与导入", () => {
  it("按目录导入：体裁目录、手法卡目录记 any、认不出的目录报出来；类型看头部「用途」", async () => {
    const src = path.join(dir, "src");
    for (const [d, f, t] of [["ganhuo", "bench-a.md", bench("A")], ["ganhuo", "bench-card.md", bench("卡", "- **用途：结构卡，不是范文。**")], ["shoufa", "bench-b.md", bench("B", "- **用途：手法卡，不是范文。**")], ["voice", "deep.md", bench("口吻")], ["weird", "bench-x.md", bench("X")]]) {
      await fs.mkdir(path.join(src, d), { recursive: true });
      await fs.writeFile(path.join(src, d, f), t);
    }
    const r = await importExemplarDir(src, dir);
    expect(r.filter((x) => x.outcome === "created").map((x) => x.id).sort()).toEqual(["bench-a", "bench-b", "bench-card", expect.stringMatching(/^voice-deep-[0-9a-f]{8}$/)]);
    expect(r.find((x) => x.file === "weird")?.error).toContain("不是体裁 id");
    const m = await readExemplarManifest(dir);
    expect(m.exemplars.map((e) => [e.id, e.genre, e.kind])).toEqual(expect.arrayContaining([["bench-a", "ganhuo", "exemplar"], ["bench-card", "ganhuo", "structure_card"], ["bench-b", "any", "technique_card"], [expect.stringMatching(/^voice-deep-/), "any", "voice_ref"]]));
    expect((await importExemplarDir(src, dir)).filter((x) => x.outcome).every((x) => x.outcome === "unchanged")).toBe(true);
  });

  it("改过的范文出新版本，旧版本文件原样留着；缺标题的拒", async () => {
    await putExemplar({ id: "bench-a", genre: "ganhuo", kind: "exemplar", title: "A", text: bench("A") }, dir);
    const r = await putExemplar({ id: "bench-a", genre: "ganhuo", kind: "exemplar", title: "A", text: bench("A", "", "改过。") }, dir);
    expect(r).toMatchObject({ outcome: "new_version", version: 2 });
    expect(await readExemplarText("bench-a", 1, dir)).toContain("正文。");
    expect(await readExemplarText("bench-a", 2, dir)).toContain("改过。");
    expect(() => parseExemplarFile("没有标题")).toThrow("一级标题");
  });

  it("清单读坏了 = 可见错误，不当空库；没有清单 = 空库", async () => {
    expect((await readExemplarManifest(dir)).exemplars).toEqual([]);
    await fs.mkdir(path.join(dir, "exemplars"), { recursive: true });
    await fs.writeFile(path.join(dir, "exemplars", "manifest.json"), "{坏");
    await expect(readExemplarManifest(dir)).rejects.toThrow("解析失败");
    await expect(previewExemplars("ganhuo", undefined, dir)).rejects.toThrow("解析失败");
    await expect(putExemplar({ id: "bench-a", genre: "ganhuo", kind: "exemplar", title: "A", text: "x" }, dir)).rejects.toThrow("解析失败");
  });
});

describe("清单、指纹与入库核对（Codex 复审 #8 #9 #10）", () => {
  const writeManifest = async (m: unknown) => { await fs.mkdir(path.join(dir, "exemplars"), { recursive: true }); await fs.writeFile(path.join(dir, "exemplars", "manifest.json"), JSON.stringify(m)); };
  it("记录结构不对（空版本、重复 / 非正整数版本号、current 不在版本里）→ 可见错误，不写", async () => {
    const v = (version: unknown) => ({ version, at: "t", hash: "h", chars: 1, title: "A" });
    for (const bad of [{ versions: [], current: 1 }, { versions: [v(1), v(1)], current: 1 }, { versions: [v(0)], current: 0 }, { versions: [v(1)], current: 2 }]) {
      await writeManifest({ schema: 1, exemplars: [{ id: "bench-a", genre: "ganhuo", kind: "exemplar", title: "A", ...bad }] });
      await expect(readExemplarManifest(dir)).rejects.toThrow("解析失败");
      await expect(putExemplar({ id: "bench-a", genre: "ganhuo", kind: "exemplar", title: "A", text: "x" }, dir)).rejects.toThrow("解析失败");
    }
    expect(await fs.readdir(path.join(dir, "exemplars"))).toEqual(["manifest.json"]);
  });

  it("版本文件被改过：读、预览、锁版都报损坏，不返回坏内容；重导原文也不说「没变」", async () => {
    await putExemplar({ id: "bench-a", genre: "ganhuo", kind: "exemplar", title: "A", text: "# A\n原文" }, dir);
    await fs.writeFile(exemplarVersionPath("bench-a", 1, dir), "# A\n被截");
    await expect(readExemplarText("bench-a", 1, dir)).rejects.toThrow("指纹对不上");
    expect((await previewExemplars("ganhuo", undefined, dir)).errors[0].error).toContain("指纹对不上");
    await expect(putExemplar({ id: "bench-a", genre: "ganhuo", kind: "exemplar", title: "A", text: "# A\n原文" }, dir)).rejects.toThrow("指纹对不上");
  });

  it("完整范文要有全文；批注引的原句（按 …… / → 切段、忽略标点）要在全文里；卡片不查", () => {
    const ok = `# T\n\n## 全文\n\n**[00:00]** 你想用一个苹果手机的钱，买五个苹果手机。漏洞是死的，可人是活的。\n\n## 批注\n\n1. **[00:00]「你想用一个苹果手机的钱买五个苹果手机」**：好\n2. **「漏洞是死的……人是活的」→「可人是活的」**：好\n`;
    expect(parseExemplarFile(ok).kind).toBe("exemplar");
    expect(() => parseExemplarFile(ok.replace("五个苹果手机」**", "十个苹果手机」**"))).toThrow("找不到：「你想用一个苹果手机的钱买十个苹果手机」");
    expect(() => parseExemplarFile("# T\n\n## 批注\n\n1. x\n")).toThrow("全文");
    expect(parseExemplarFile("# T\n- **用途：结构卡，不是范文。**\n\n## 批注\n\n1. **「全文里没有」**\n").kind).toBe("structure_card");
  });
});

describe("按体裁预览", () => {
  const put = (id: string, genre: "ganhuo" | "renwu" | "any", kind: "exemplar" | "structure_card" | "technique_card", size = 100) =>
    putExemplar({ id, genre, kind, title: id, text: `# ${id}\n${"字".repeat(size)}` }, dir);

  it("最多 3 篇全文；完整范文在卡片前；别的体裁不凑数，any 手法卡可以给", async () => {
    await put("bench-card", "ganhuo", "structure_card");
    await put("bench-z", "ganhuo", "exemplar");
    await put("bench-y", "ganhuo", "exemplar");
    await put("bench-other", "renwu", "exemplar");
    await put("bench-trick", "any", "technique_card");
    const p = await previewExemplars("ganhuo", undefined, dir);
    expect(p.entries.map((e) => e.id)).toEqual(["bench-y", "bench-z", "bench-card"]);
    expect(p.entries[0]).toMatchObject({ version: 1, chars: Array.from(`# bench-y\n${"字".repeat(100)}`).length });
    expect(p.entries[0].text).toContain("字".repeat(100));
    expect(p.skipped).toEqual([{ id: "bench-trick", reason: "已够 3 篇" }]);
    const none = await previewExemplars("shiyan", undefined, dir);
    expect(none.note).toContain("本体裁无范文");
    expect(none.entries.map((e) => e.id)).toEqual(["bench-trick"]);
  });

  it("预算不够整篇跳过，不截半篇", async () => {
    await put("bench-big", "ganhuo", "exemplar", PREVIEW_BUDGET_CHARS);
    await put("bench-small", "ganhuo", "exemplar", 50);
    const p = await previewExemplars("ganhuo", undefined, dir);
    expect(p.entries.map((e) => e.id)).toEqual(["bench-small"]);
    expect(p.skipped[0]).toMatchObject({ id: "bench-big", reason: expect.stringContaining("不截半篇") });
  });

  it("某篇文件坏了：报在 errors、跳过，其余照给", async () => {
    await put("bench-a", "ganhuo", "exemplar");
    await put("bench-b", "ganhuo", "exemplar");
    await fs.rm(exemplarVersionPath("bench-a", 1, dir));
    const p = await previewExemplars("ganhuo", undefined, dir);
    expect(p.entries.map((e) => e.id)).toEqual(["bench-b"]);
    expect(p.errors).toEqual([expect.objectContaining({ id: "bench-a" })]);
  });

  it("近 30 天用过 2 次的有替补才跳；每篇稿只算一次；正在写的这篇不算", async () => {
    for (const id of ["bench-a", "bench-b", "bench-c", "bench-d"]) await put(id, "ganhuo", "exemplar");
    const lock = (n: number) => saveContent({ title: `稿${n}`, body: "", platform: "douyin", status: "drafting", tags: [],
      draftPath: { kind: "thin", startedAt: "x", angle: { version: 1, main_line: "m", for_whom: "f", opening: "o", why_viral: "w", chain: [], founder_words: "f", at: new Date().toISOString(), exemplars: [{ id: "bench-a", version: 1 }, { id: "bench-a", version: 1 }] } } } as never, dir);
    const first = await lock(1);
    await lock(2);
    const p = await previewExemplars("ganhuo", undefined, dir);
    expect(p.entries.map((e) => e.id)).toEqual(["bench-b", "bench-c", "bench-d"]);
    expect(p.skipped[0]).toMatchObject({ id: "bench-a", reason: expect.stringContaining("近 30 天已用 2 次") });
    expect((await previewExemplars("ganhuo", first.id, dir)).entries.map((e) => e.id)).toContain("bench-a");
  });

  it("没有替补时照给用过多次的那篇", async () => {
    await put("bench-a", "ganhuo", "exemplar");
    for (const n of [1, 2, 3]) await saveContent({ title: `稿${n}`, body: "", platform: "douyin", status: "drafting", tags: [],
      draftPath: { kind: "thin", startedAt: "x", angle: { version: 1, main_line: "m", for_whom: "f", opening: "o", why_viral: "w", chain: [], founder_words: "f", at: new Date().toISOString(), exemplars: [{ id: "bench-a", version: 1 }] } } } as never, dir);
    expect((await previewExemplars("ganhuo", undefined, dir)).entries.map((e) => e.id)).toEqual(["bench-a"]);
  });

  it("锁版校验：库里没有 / 版本不存在 / 别的体裁 → 拒；手册点名的范文不在库里降级成提示", async () => {
    await put("bench-a", "ganhuo", "exemplar");
    await put("bench-r", "renwu", "exemplar");
    expect(await validatePins([{ id: "bench-a", version: 1 }], "ganhuo", dir)).toBeNull();
    expect(await validatePins([{ id: "bench-x", version: 1 }], "ganhuo", dir)).toContain("没有");
    expect(await validatePins([{ id: "bench-a", version: 9 }], "ganhuo", dir)).toContain("第 9 版");
    expect(await validatePins([{ id: "bench-r", version: 1 }], "ganhuo", dir)).toContain("凑数");
    expect(await missingExemplarRefs("- `bench-a`\n- `bench-gone`（某某）", dir)).toEqual([{ id: "bench-gone", note: "范文库里没有这篇" }]);
  });
});

describe("每体裁 6 篇完整范文上限（Codex 复审 #6）", () => {
  it("第 7 篇拒并列出现有的；指定换掉一篇才入库，被换下的不再预览也不能新锁，旧版本照读；卡片不占名额", async () => {
    for (let i = 1; i <= 6; i++) await putExemplar({ id: `bench-${i}`, genre: "ganhuo", kind: "exemplar", title: `${i}`, text: `# ${i}` }, dir);
    await putExemplar({ id: "bench-card", genre: "ganhuo", kind: "structure_card", title: "卡", text: "# 卡" }, dir);
    await expect(putExemplar({ id: "bench-7", genre: "ganhuo", kind: "exemplar", title: "7", text: "# 7" }, dir)).rejects.toThrow(/上限 6[\s\S]*bench-1/);
    await expect(putExemplar({ id: "bench-7", genre: "ganhuo", kind: "exemplar", title: "7", text: "# 7", replaces: "bench-x" }, dir)).rejects.toThrow("上限");
    expect(await putExemplar({ id: "bench-7", genre: "ganhuo", kind: "exemplar", title: "7", text: "# 7", replaces: "bench-1" }, dir)).toMatchObject({ outcome: "created" });
    expect((await readExemplarManifest(dir)).exemplars.find((e) => e.id === "bench-1")?.retired).toMatchObject({ replaced_by: "bench-7" });
    expect(await validatePins([{ id: "bench-1", version: 1 }], "ganhuo", dir)).toContain("换下");
    expect(await readExemplarText("bench-1", 1, dir)).toBe("# 1");
    expect(await putExemplar({ id: "bench-2", genre: "ganhuo", kind: "exemplar", title: "2", text: "# 2 改" }, dir)).toMatchObject({ outcome: "new_version" });
  });
});

describe("写法一节锁版", () => {
  it("技能里有写法一节；立意时存快照，技能改了续写仍按锁住的那一版取", async () => {
    expect((await currentMethod()).text).toContain("怎么让人看下去");
    const skill = path.join(dir, "SKILL.md");
    await fs.writeFile(skill, "前\n<!-- method:start -->\n写法一\n<!-- method:end -->\n后");
    const v1 = await pinMethod(dir, skill);
    await fs.writeFile(skill, "前\n<!-- method:start -->\n写法二\n<!-- method:end -->\n后");
    const v2 = await pinMethod(dir, skill);
    expect(v1.version).not.toBe(v2.version);
    expect(await lockedMethod(v1.version, dir)).toBe("写法一");
    expect(() => methodSection("没有标记")).toThrow("method:start");
    await expect(lockedMethod("0123456789abcdef", dir)).rejects.toThrow("读不了");
    await fs.writeFile(path.join(dir, "exemplars", "method", `${v1.version}.md`), "写法一被改");
    await expect(lockedMethod(v1.version, dir)).rejects.toThrow("指纹对不上");
  });
});
