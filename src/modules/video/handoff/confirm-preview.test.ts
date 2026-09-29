/**
 * 认稿确认窗给足信息（2026-09-29 spec）：弹窗、open、通知、时钟一律注入假的，绝不弹真窗、不真 open。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { callVideo, HAS_FFMPEG, makeFixture, seedAccepted, type HandoffFixture } from "./handoff-testkit.js";
import { contentFile, initializeProjectLayout, resolveContentProject } from "../../../storage/content-project.js";
import { getContent, type Content } from "../../../storage/local-store.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { saveCoverage } from "./project-evidence.js";
import { pullDir } from "./pull-store.js";
import { setPullDeps, type PullDeps } from "./pull-deps.js";
import type { DialogOutcome, DialogRunner } from "./dialog.js";
import { executeVideo } from "../../../tools/video.js";

type Step = DialogOutcome<string> | "first" | ((items?: string[]) => DialogOutcome<string>);
const ok = (value: string): DialogOutcome<string> => ({ kind: "ok", value });

let clock = 0;
let fx: HandoffFixture;
let file: string;

function fakes(script: Step[], extra: Partial<PullDeps> = {}) {
  const shown: Array<{ kind: string; prompt: string; items?: string[]; timeoutSec: number }> = [];
  const opened: string[] = [];
  const next = (items?: string[]): DialogOutcome<string> => {
    const step = script.shift() ?? { kind: "timeout" };
    if (step === "first") return ok(items![0]);
    return typeof step === "function" ? step(items) : step;
  };
  const dialog: DialogRunner = {
    choose: async (o) => { shown.push({ kind: "choose", prompt: o.prompt, items: o.items, timeoutSec: o.timeoutSec }); return next(o.items); },
    ask: async (o) => { shown.push({ kind: "ask", prompt: o.prompt, timeoutSec: o.timeoutSec }); return next(); },
    input: async (o) => { shown.push({ kind: "input", prompt: o.prompt, timeoutSec: o.timeoutSec }); return next(); },
  };
  setPullDeps({
    probe: async () => ({ ok: true as const }), dialog, now: () => clock, benchPort: 5555,
    transcriber: { transcribe: async () => ({ ok: false, unavailable: true, reason: "测试不转写" }) },
    opener: async (t) => { opened.push(t); return { ok: true }; },
    benchReachable: async () => true, duration: async () => 83_000, ...extra,
  });
  return { shown, opened };
}

beforeEach(async () => {
  clock = Date.parse("2026-09-29T10:00:00Z");
  fx = await makeFixture();
  await fs.unlink(path.join(fx.dir, "video.json"));
  await initializeProjectLayout(fx.dir, "lib-deadbeef", "default");
  file = path.join(fx.outside, "AI 工具分享.mov");
  await fs.writeFile(file, "fake aroll");
  fakes([]);
});
afterEach(async () => { setPullDeps(null); await fx.cleanup(); });

async function cited(c: Content): Promise<Content> {
  const first = c.body.slice(0, c.body.indexOf("。") + 1);
  await saveCoverage(c, { draft_hash: draftHash(c), citations: [{ start: 0, end: first.length, excerpt: first, evidence_id: "creator", sourceType: "creator_opinion", quote: "", verification: "亲历" }], reviewed_by: "writer", reviewed_at: new Date().toISOString() }, fx.dir);
  return (await getContent(c.id, fx.dir))!;
}

const call = (params: Record<string, unknown>) => executeVideo({ _dataDir: fx.dir, _host: "codex", ...params });
async function confirm(extra: Record<string, unknown> = {}) {
  const m = await call({ action: "match", aroll_path: file, request_id: `m-${Math.random().toString(36).slice(2)}` });
  return call({ action: "confirm", receipt_id: m.receipt_id, cover_text: "三招省时", target_seconds: 90, request_id: "c-1", ...extra });
}
const menu = (item: string): Step[] => [ok("查看 / 修改…"), ok(item)];
const asks = (shown: Array<{ kind: string; prompt: string }>) => shown.filter((s) => s.kind === "ask").map((s) => s.prompt);

describe("确认窗多几行", () => {
  it("原片时长与修改时间、认稿依据、定稿首句", async () => {
    await cited(await seedAccepted(fx.dir));
    const { shown } = fakes(["first", ok("确认")]);
    expect(await confirm()).toMatchObject({ ok: true });
    const text = asks(shown)[0];
    expect(text).toMatch(/原片时长：1 分 23 秒，修改于 \d{4}-\d\d-\d\d \d\d:\d\d/);
    expect(text).toContain("认稿依据：");
    expect(text).toContain("定稿首句：今天聊聊我怎么用 AI 工具省下每天两小时。");
    expect(text).not.toContain("已找到");
  });

  it("时长读不出时写明", async () => {
    await cited(await seedAccepted(fx.dir));
    const { shown } = fakes(["first", ok("确认")], { duration: async () => null });
    await confirm();
    expect(asks(shown)[0]).toContain("原片时长：时长读不出");
  });
});

describe("查看 / 修改…", () => {
  it("预览原片 / 看定稿 / 在工作台打开：open 对的目标，回到确认窗，不写记录", async () => {
    const c = await cited(await seedAccepted(fx.dir));
    const { shown, opened } = fakes(["first", ...menu("预览原片"), ...menu("看定稿"), ...menu("在工作台打开"), { kind: "cancel" }]);
    expect(await confirm()).toMatchObject({ ok: false, code: "confirm_declined" });
    expect(opened).toEqual([file, contentFile(c.id, fx.dir, "draft.md"), `http://127.0.0.1:5555/#/editor/${c.id}`]);
    expect(opened[1]).toMatch(/01-script\/manuscripts\/current\.md$/);
    expect(shown.map((s) => s.kind)).toEqual(["choose", "ask", "choose", "ask", "choose", "ask", "choose", "ask"]);
    expect(shown[2].items).toEqual(["预览原片", "看定稿", "在工作台打开", "改封面字和时长"]);
    await expect(fs.access(contentFile(c.id, fx.dir, "decisions.json"))).rejects.toThrow();
    await expect(fs.readdir(pullDir(fx.dir, "confirmations"))).rejects.toThrow();
  });

  it("列表取消 = 回确认窗，不算放弃", async () => {
    await cited(await seedAccepted(fx.dir));
    const { opened } = fakes(["first", ok("查看 / 修改…"), { kind: "cancel" }, ok("确认")]);
    expect(await confirm()).toMatchObject({ ok: true, cover_text: "三招省时" });
    expect(opened).toEqual([]);
  });

  it("open 失败 / 工作台不通 / 定稿缺失：下一次确认窗顶部带原因", async () => {
    const c = await cited(await seedAccepted(fx.dir));
    const { shown } = fakes(["first", ...menu("预览原片"), ...menu("在工作台打开"), ...menu("看定稿"), ok("确认")], {
      opener: async () => ({ ok: false, reason: "没有默认程序" }), benchReachable: async () => false,
    });
    await fs.rm(contentFile(c.id, fx.dir, "draft.md"));
    await confirm();
    const [, afterAroll, afterBench, afterScript] = asks(shown);
    expect(afterAroll.split("\n")[0]).toBe("刚才打不开：没有默认程序");
    expect(afterBench.split("\n")[0]).toBe("刚才打不开：工作台没在运行，打不开");
    expect(afterScript.split("\n")[0]).toMatch(/^刚才打不开：定稿文件不在：/);
  });
});

describe("计时", () => {
  it("预览后确认窗 timeout 重新计满", async () => {
    await cited(await seedAccepted(fx.dir));
    const later = (v: DialogOutcome<string>) => () => { clock += 4 * 60_000; return v; };
    const { shown } = fakes(["first", later(ok("查看 / 修改…")), ok("预览原片"), ok("确认")]);
    expect(await confirm()).toMatchObject({ ok: true });
    const windows = shown.filter((s) => s.kind === "ask");
    expect(windows[0].timeoutSec).toBe(300);
    expect(windows[1].timeoutSec).toBe(300);
  });

  it("总时长到 20 分钟上限回 confirm_timeout，什么都不记", async () => {
    const c = await cited(await seedAccepted(fx.dir));
    const script: Step[] = ["first"];
    for (let i = 0; i < 6; i++) script.push(() => { clock += 4 * 60_000; return ok("查看 / 修改…"); }, ok("预览原片"));
    const { shown } = fakes(script);
    const res = await confirm();
    expect(res).toMatchObject({ ok: false, code: "confirm_timeout" });
    expect(String(res.error)).toContain("重新 confirm");
    expect(shown.filter((s) => s.kind === "ask").every((s) => s.timeoutSec <= 300)).toBe(true);
    await expect(fs.access(contentFile(c.id, fx.dir, "decisions.json"))).rejects.toThrow();
  });
});

describe("补交接提示已有产物", () => {
  it("有成片和封面时多一行，列最新成片与封面张数", async () => {
    const c = await cited(await seedAccepted(fx.dir));
    const root = resolveContentProject(c.id, fx.dir)!.project_root;
    await fs.mkdir(path.join(root, "04-edit", "exports"), { recursive: true });
    await fs.writeFile(path.join(root, "04-edit", "old.mp4"), "x");
    await fs.utimes(path.join(root, "04-edit", "old.mp4"), new Date("2026-01-01"), new Date("2026-01-01"));
    await fs.writeFile(path.join(root, "04-edit", "exports", "final.mov"), "x");
    await fs.mkdir(path.join(root, "05-cover", "v001"), { recursive: true });
    for (const n of ["a.png", "b.jpg"]) await fs.writeFile(path.join(root, "05-cover", "v001", n), "x");
    await fs.writeFile(path.join(root, "05-cover", "top.png"), "x");
    const { shown } = fakes(["first", ok("确认")]);
    await confirm();
    expect(asks(shown)[0]).toContain("已找到成片：final.mov（1 分 23 秒） ／ 已找到封面：2 张（去工作台批）");
  });
});

describe.skipIf(!HAS_FFMPEG)("交接成功通知", () => {
  let hx: HandoffFixture;
  let id: string;
  beforeEach(async () => { hx = await makeFixture(); id = (await seedAccepted(hx.dir)).id; });
  afterEach(async () => { await hx.cleanup(); });
  const handoff = () => callVideo(hx.dir, { action: "handoff", content_id: id, aroll_path: hx.aroll });

  it("真正提交触发一次，重放不触发", async () => {
    const calls: Array<{ message: string; url: string }> = [];
    setPullDeps({ notifier: async (o) => { calls.push(o); return { ok: true }; } });
    const res = await handoff();
    expect(res).toMatchObject({ ok: true, status: "handed_off" });
    expect(res.warnings).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain("已交给剪辑：");
    expect(calls[0].url).toContain(`/#/editor/${id}`);
    expect(await handoff()).toMatchObject({ ok: true, replayed: true });
    expect(calls).toHaveLength(1);
  });

  it("通知弹不出来只进 warnings，交接仍 ok", async () => {
    setPullDeps({ notifier: async () => ({ ok: false, reason: "没有图形会话" }) });
    const res = await handoff();
    expect(res).toMatchObject({ ok: true, status: "handed_off", warnings: [expect.stringContaining("没有图形会话")] });
    expect((await getContent(id, hx.dir))?.status).toBe("editing");
  });
});
