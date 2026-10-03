import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { benchmarkInbox, learnPrepare, learnSave } from "./learn-from.js";
import { readObservations } from "./obs-store.js";
import { calibrationDir, ensureCalibration } from "./store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-l-")); });
const s = (i: number, extra: Record<string, unknown> = {}) => ({ title: `对标${i}`, script: `稿子${i}`, metrics: { views: 1000 * i }, impression: "高", why: "开头狠", ...extra });

describe("§六 对标导入", () => {
  it("少于 3 条拒绝，多于 15 条拒绝", async () => {
    expect(await learnPrepare({ account: "A", samples: [s(1), s(2)] }, dir)).toMatchObject({ code: "too_few" });
    expect(await learnPrepare({ account: "A", samples: Array.from({ length: 16 }, (_, i) => s(i)) }, dir)).toMatchObject({ code: "too_many" });
  });
  it("单条失败其余照做并列出；印象判断必填；JSON 串照收", async () => {
    const r = await learnPrepare({ account: "A", samples: JSON.stringify([s(1), s(2), s(3), s(4, { impression: "" })]) }, dir);
    expect(r).toMatchObject({ ok: true });
    expect((r.failed as unknown[])).toHaveLength(1);
  });
  it("Way b：视频必须在资料库对标文件夹；转写没就绪按指引提示", async () => {
    const inbox = benchmarkInbox(dir);
    await fs.mkdir(inbox, { recursive: true });
    const transcribe = async (p: string) => (p.endsWith("ok.mp4") ? { ok: true as const, text: "转写出的稿子" } : { ok: false as const, reason: "x", notReady: true });
    const r = await learnPrepare({ account: "A", samples: [s(1), s(2), s(3, { script: undefined, video_path: path.join(inbox, "ok.mp4") }), s(4, { script: undefined, video_path: path.join(inbox, "bad.mp4") }), s(5, { script: undefined, video_path: "/tmp/elsewhere.mp4" })] }, dir, { transcribe });
    const failed = (r.failed as Array<{ error: string }>).map((f) => f.error).join("|");
    expect(failed).toMatch(/转写模型还没就绪/);
    expect(failed).toMatch(/对标视频/);
    expect((r.samples as Array<{ way: string }>).map((x) => x.way)).toEqual(["a", "a", "b"]);
  });
  it("落盘要创始人过目；每账号一份笔记、模式库追加、信号只进观察不改公式、原话标不可引用", async () => {
    const p = await learnPrepare({ account: "蜗牛学长", samples: [s(1), s(2), s(3)] }, dir);
    expect(await learnSave({ import_id: p.import_id, patterns: [], rubric_signals: [] }, dir)).toMatchObject({ code: "needs_review" });
    const r = await learnSave({ import_id: p.import_id, founder_reviewed: true, patterns: [{ name: "反问开头", description: "d", example: "e" }], rubric_signals: ["开头反问能撑 HP"] }, dir);
    expect(r).toMatchObject({ ok: true, patterns: 1, rubric_signals_as_observations: 1 });
    const note = JSON.parse(await fs.readFile(path.join(calibrationDir(dir), "benchmarks", "蜗牛学长.json"), "utf-8"));
    expect(note.citable).toBe(false);
    const { state, rubric } = await ensureCalibration(dir);
    expect(rubric.formula_text).toContain("/ 8.5 × 2.0");
    expect(state).toMatchObject({ benchmark_status: "imported", benchmark_sample_count: 3 });
    expect((await readObservations(dir)).live[0].source).toBe("benchmark:蜗牛学长");
    expect(await learnSave({ import_id: p.import_id, founder_reviewed: true, patterns: [] }, dir)).toMatchObject({ code: "already_saved" });
  });
});
