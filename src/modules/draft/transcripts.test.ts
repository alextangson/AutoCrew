/** 创始人转写与口吻参考（spec 2026-10-15 §8、§15.1、§15.2、§16）：统一解析、成片优先、探测 / 词级不读、AI 稿只进 voice_refs */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { founderTranscripts, parseTranscriptText, sourceTypeOf } from "./transcripts.js";
import { excerpt, voiceRefs } from "./voice-refs.js";
import { executeDraft } from "../../tools/draft.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "transcripts-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const whisper = (texts: string[]) => ({ systeminfo: "x", result: { language: "zh" }, transcription: texts.map((text, i) => ({ timestamps: { from: `${i}`, to: `${i + 1}` }, text })) });

async function project(id: string, run: string, source: string, full: unknown, extra: Record<string, unknown> = {}) {
  const t = path.join(dir, "contents", id, "99-cache", run, "transcription");
  await fs.mkdir(t, { recursive: true });
  await fs.writeFile(path.join(t, "transcription-manifest.json"), JSON.stringify({ version: 1, source }));
  if (full !== undefined) await fs.writeFile(path.join(t, "full.json"), typeof full === "string" ? full : JSON.stringify(full));
  for (const [name, v] of Object.entries(extra)) await fs.writeFile(path.join(t, name), JSON.stringify(v));
}

describe("统一解析", () => {
  it("whisper / segments / ChatCut utterances / 数组都认；词级结果不当正文", () => {
    expect(parseTranscriptText(whisper(["你是不是也这样，", "手上的事越难"]))).toBe("你是不是也这样，手上的事越难");
    expect(parseTranscriptText({ segments: [{ text: "一" }, { text: "二" }] })).toBe("一二");
    expect(parseTranscriptText({ assetId: "a", utterances: [{ text: "Just load." }, { text: "Uh." }] })).toBe("Just load. Uh.");
    expect(parseTranscriptText({ words: [{ word: "我" }], source: "x", pass_name: "full" })).toBeNull();
    expect(sourceTypeOf("/x/02-aroll/同样用AI-原片.mov")).toBe("raw");
    expect(sourceTypeOf("/x/07-delivery/registered/final.mp4")).toBe("final");
    expect(sourceTypeOf("/x/somewhere.mov")).toBe("raw");
  });
});

describe("按作品找转写", () => {
  it("成片优先、原片标非发布版；探测片段和词级文件不读；坏文件报出来不当没有；只有词级的跳过", async () => {
    await project("content-1790000000001-aaaaaa", "aroll-1", "/lib/02-aroll/x-原片.mov", whisper(["原片说的话。"]), { "probe-1-2.json": whisper(["探测"]), "full.words.json": { words: [] } });
    await project("content-1790000000002-bbbbbb", "final-1", "/lib/07-delivery/registered/final.mp4", whisper(["成片说的话。"]));
    await project("content-1790000000003-cccccc", "bad", "/lib/02-aroll/y.mov", "{坏");
    await project("content-1790000000004-dddddd", "ab", "/lib/02-aroll/z.mov", undefined);
    const r = await founderTranscripts(dir);
    expect(r.items.map((x) => [x.content_id, x.source_type, x.text])).toEqual([
      ["content-1790000000002-bbbbbb", "final", "成片说的话。"],
      ["content-1790000000001-aaaaaa", "raw", "原片说的话。"],
    ]);
    expect(r.items[1].label).toContain("原片，非发布版");
    expect(r.errors).toEqual([expect.stringContaining("content-1790000000003-cccccc")]);
  });

  it("权限错误不当成没有材料：记进 errors（Codex 复审 #11）", async () => {
    await project("content-1790000000005-eeeeee", "run", "/lib/02-aroll/x.mov", whisper(["说的话。"]));
    const cache = path.join(dir, "contents", "content-1790000000005-eeeeee", "99-cache");
    await fs.chmod(cache, 0o000);
    try {
      const r = await founderTranscripts(dir);
      expect(r.items).toEqual([]);
      expect(r.errors).toEqual([expect.stringContaining("读不了")]);
    } finally { await fs.chmod(cache, 0o755); }
  });

  it("voice_refs 最多两篇转写 + 一篇认可过的 AI 稿（标明 AI 起草）；长转写整句节选", () => {
    const long = "这是一句话。".repeat(1000);
    const refs = voiceRefs([
      { content_id: "c1", source_type: "final", label: "成片转写（发布版）", text: long, file: "f", at: 2 },
      { content_id: "c2", source_type: "raw", label: "原片转写，非发布版", text: "短。", file: "f", at: 1 },
      { content_id: "c3", source_type: "raw", label: "原片转写，非发布版", text: "第三篇。", file: "f", at: 0 },
    ], [{ kind: "approved_draft", contentId: "c9", title: "认过的稿", text: "AI 写的", id: "x", sourceRevision: 1, chunkIndex: 0, score: 1, sameTopic: false, excerptHash: "h" }], new Map([["c1", "一号"]]));
    expect(refs.map((r) => [r.kind, r.content_id])).toEqual([["transcript", "c1"], ["transcript", "c2"], ["approved_ai_draft", "c9"]]);
    expect(refs[0]).toMatchObject({ title: "一号", excerpted: true });
    expect(refs[0].text.endsWith("。")).toBe(true);
    expect(refs[2].label).toContain("AI 起草");
    expect(excerpt("短").excerpted).toBe(false);
  });

  it("start：voice_refs 标「口吻参考，不是范文」；本选题自己的转写进 firsthand，别的稿的不进", async () => {
    await project("content-1790000000002-bbbbbb", "final-1", "/lib/07-delivery/final.mp4", whisper(["别的稿成片。"]));
    const s = await executeDraft({ action: "start", inspiration: "用了 AI 反而更忙", _dataDir: dir, _host: "claude-code", _session: "s1" }) as { context: Record<string, any> };
    if (!s.context) throw new Error(JSON.stringify(s));
    expect(s.context.voice_refs.label).toContain("口吻参考，不是范文");
    expect(s.context.voice_refs.refs).toEqual([expect.objectContaining({ kind: "transcript", text: "别的稿成片。" })]);
    expect(JSON.stringify(s.context.firsthand)).not.toContain("别的稿成片");
  });
});
