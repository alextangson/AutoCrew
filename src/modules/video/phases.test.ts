/**
 * phases.test.ts —— 单步执行体的直接单测（runner 那边测的是调度，这里测「一步之内做了什么」）。
 * 重点在两件事：产出的 next 状态与 revision 对不对；失败到底算 blocked 还是 failed。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executePhase, stepWarning, type PhaseContext, type StepResult } from "./phases.js";
import { updateContent } from "../../storage/local-store.js";
import { ingestAroll } from "./ingest.js";
import {
  cleanWindow,
  fakeRenderSpawn,
  fakeRunLoop,
  fakeUvSpawn,
  fixtureDenseTranscript,
  fixtureLongTranscript,
  routedSpawn,
  seedBrollAsset,
  seedEngineConfig,
  seedVideoContent,
  throwingRunLoop,
} from "./testkit.js";
import { ASR_META_FILE, ASR_OUT_FILE } from "./transcribe-input.js";
import { promoteStaging, readVersioned, readVideoAssets, videoDir, writeVersioned } from "./video-store.js";
import type {
  TranscriptClean,
  VideoCut,
  VideoEditUnits,
  VideoEditorPlan,
  VideoPhase,
  VideoState,
  VideoTranscript,
} from "./types.js";

let dir: string;
let contentId: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-phases-"));
  contentId = (await seedVideoContent(dir)).contentId;
  await seedEngineConfig(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function ctx(
  phase: VideoPhase,
  revisions: VideoState["revisions"] = {},
  routes = { uv: fakeUvSpawn("ok") },
  extra: Partial<PhaseContext> = {},
): PhaseContext {
  return {
    dataDir: dir,
    contentId,
    state: { schemaVersion: 1, entryType: "aroll", phase, state: "running", revisions, updatedAt: new Date().toISOString() },
    // 模型调用一律注入假实现——测试永不真调模型
    deps: { spawnImpl: routedSpawn(routes), runLoopImpl: fakeRunLoop([]) },
    jobId: "vjob-test",
    abortSignal: new AbortController().signal,
    ...extra,
  };
}

/**
 * runner 在 CAS 通过之后做的那一步：把 staging 定版。直测阶段体时要自己补上，
 * 否则后一个阶段读不到前一个阶段的产物——产物先落 staging 正是被测的纪律本身。
 */
async function promote(result: StepResult): Promise<void> {
  if (!result.ok || !result.staged) return;
  for (const item of result.staged) {
    await promoteStaging(videoDir(dir, contentId), item.base, "vjob-test", item.revision);
  }
}

/** 跑一步并定版，返回原始结果——多数用例关心的是「产物长什么样」而不是 staging 中间态 */
async function runPhase(context: PhaseContext): Promise<StepResult> {
  const result = await executePhase(context);
  await promote(result);
  return result;
}

describe("executePhase 分派", () => {
  it("人工门阶段不是可执行阶段 → not_runnable（不静默停住）", async () => {
    const r = await executePhase(ctx("review"));
    expect(r.ok === false && r.errorCode).toBe("not_runnable");
    expect(r.ok === false && r.reason).toContain("review");
  });

  it("done 阶段同样不可执行", async () => {
    expect((await executePhase(ctx("done"))).ok).toBe(false);
  });
});

describe("ingest", () => {
  it("成功 → 自动接续到 transcribe/queued，素材登记完成", async () => {
    const r = await executePhase(ctx("ingest"));
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "transcribe", state: "queued" });
    expect((await readVideoAssets(dir, contentId))[0]).toMatchObject({ kind: "aroll", status: "ready" });
  });
});

describe("transcribe", () => {
  it("成功 → 排 cut 计算步 + 四件产物一起定版 + 对齐度已算（假模型不调工具，清洗整体降级）", async () => {
    await ingestAroll(dir, contentId);
    const r = await runPhase(ctx("transcribe"));
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "cut", state: "queued" });
    expect(r.ok && r.revisions).toEqual({ transcript: 1, clean: 1, cut: 1 });
    // 四件全部先落 staging，由 runner 在 CAS 之后定版（转写纠错 spec §2）
    expect(r.ok && r.staged).toEqual([
      { base: "transcript", revision: 1 },
      { base: "transcript-clean", revision: 1 },
      { base: "edit-units", revision: 1 },
      { base: "cut", revision: 1 },
    ]);

    const transcript = await readVersioned<VideoTranscript>(videoDir(dir, contentId), "transcript", 1);
    expect(transcript?.scriptAlignment?.matchedRatio).toBeGreaterThan(0);
    const clean = await readVersioned<TranscriptClean>(videoDir(dir, contentId), "transcript-clean", 1);
    expect(clean).toMatchObject({ schemaVersion: 1, transcriptRevision: 1, baseCleanRevision: null, origin: "llm" });
    // 清洗跑砸了照样产出 clean（手改要有基）：内容退回转写原样，段 id 也仍是 seg-XXXX
    expect(clean?.warning).toContain("没跑成");
    expect(clean?.segments).toEqual(transcript?.segments);
    const cut = await readVersioned<VideoCut>(videoDir(dir, contentId), "cut", 1);
    expect(cut).toMatchObject({ origin: "default_all", keeps: ["seg-0001", "seg-0002"], cleanRevision: 1 });
    const units = await readVersioned<VideoEditUnits>(videoDir(dir, contentId), "edit-units", 1);
    expect(units).toMatchObject({ origin: "raw", suggestedDrops: [], cleanRevision: 1 });
    // 兜底单元表就是转写分句原样搬运（I2：事实与派生分家，但派生的第一版等于事实）
    expect(units?.segments.map((s) => s.id)).toEqual(["seg-0001", "seg-0002"]);
  });

  it("重跑转写 → 三条 revision 一起递增，旧版不动", async () => {
    await ingestAroll(dir, contentId);
    await runPhase(ctx("transcribe"));
    const r = await runPhase(ctx("transcribe", { transcript: 1, clean: 1, cut: 1 }));
    expect(r.ok && r.revisions).toEqual({ transcript: 2, clean: 2, cut: 2 });
    expect(await readVersioned(videoDir(dir, contentId), "transcript", 1)).not.toBeNull();
    expect(await readVersioned(videoDir(dir, contentId), "transcript-clean", 1)).not.toBeNull();
  });

  it("素材还没登记 → aroll_missing（failed，不是 blocked）", async () => {
    const r = await executePhase(ctx("transcribe"));
    expect(r.ok === false && r.errorCode).toBe("aroll_missing");
    expect(r.ok === false && r.blockedReason).toBeUndefined();
  });

  it("sidecar 未就绪 → blocked（阻塞与失败是两种命运）", async () => {
    await ingestAroll(dir, contentId);
    const r = await executePhase(ctx("transcribe", {}, { uv: fakeUvSpawn("model_missing") }));
    expect(r.ok === false && r.blockedReason).toBe("asr_not_ready");
  });
});

/**
 * 三件套在 transcribe 这一步的装配（转写纠错 spec §3/§4）：热词进 sidecar 与缓存键，
 * 清洗结果进 clean 并成为 cut/单元表的文字来源。这里验的是**接线**，
 * 提取与对齐的判断力分别在 hotwords.test.ts / transcript-clean*.test.ts。
 */
describe("transcribe 的热词与清洗装配", () => {
  /** 记录每次 uv 调用的 argv，再交给正常的假 sidecar——热词有没有真传下去只能这么验 */
  function recordingUv(seen: string[][]): (args: readonly string[]) => ReturnType<ReturnType<typeof fakeUvSpawn>> {
    const inner = fakeUvSpawn("ok");
    return (args) => {
      seen.push([...args]);
      return inner(args);
    };
  }

  const hotwordArg = (seen: string[][]): string | undefined => {
    const call = seen.find((args) => args.includes("--hotword"));
    return call?.[call.indexOf("--hotword") + 1];
  };

  it("稿子里的拉丁专名进热词表，原样拼进 sidecar 的 --hotword", async () => {
    contentId = (await seedVideoContent(dir, { body: "今天聊聊 DeepSeek 与 Harness" })).contentId;
    const seen: string[][] = [];
    await ingestAroll(dir, contentId);
    const r = await runPhase(ctx("transcribe", {}, { uv: recordingUv(seen) }));
    expect(r.ok).toBe(true);
    expect(hotwordArg(seen)).toBe("DeepSeek Harness");
  });

  it("稿子里没有拉丁词 → 不拼 --hotword（缺省行为逐字节不变）", async () => {
    contentId = (await seedVideoContent(dir, { body: "今天聊聊效率" })).contentId;
    const seen: string[][] = [];
    await ingestAroll(dir, contentId);
    await runPhase(ctx("transcribe", {}, { uv: recordingUv(seen) }));
    expect(hotwordArg(seen)).toBeUndefined();
  });

  /**
   * 缓存键与真正送进 sidecar 的热词表必须是同一份：改了稿子里的专名就得重跑 ASR，
   * 否则盘上那份「用旧热词认出来的转写」会被当成新结果，静默地把错字留在片子里。
   */
  it("热词变了 → ASR 缓存不再命中，老老实实重跑", async () => {
    contentId = (await seedVideoContent(dir, { body: "今天聊聊 DeepSeek" })).contentId;
    await ingestAroll(dir, contentId);
    await runPhase(ctx("transcribe"));
    // 同一份稿子重跑 → 命中缓存（uv 一被调起就崩，命中的那一跑压根不碰它）
    const hit = await runPhase(ctx("transcribe", { transcript: 1, clean: 1, cut: 1 }, { uv: fakeUvSpawn("crash") }));
    expect(hit.ok).toBe(true);
    // 换一个专名 → 热词 hash 翻转 → 缓存作废 → 真去调 sidecar（这次它崩了，所以看得见）
    await updateContent(contentId, { body: "今天聊聊 Harness" }, dir);
    const miss = await executePhase(ctx("transcribe", { transcript: 2, clean: 2, cut: 2 }, { uv: fakeUvSpawn("crash") }));
    expect(miss.ok === false && miss.errorCode).toBe("asr_exit_1");
  });

  it("清洗跑成了 → clean 换成 cseg 序列，cut 与单元表跟着指向清洗后的分句", async () => {
    contentId = (await seedVideoContent(dir, { body: "今天聊聊效率" })).contentId;
    // 用词覆盖完整的那份转写：`fixtureTranscript` 的「聊聊」压根没有词时间戳，
    // 重新分词会被防过拟合闸当成「凭空插了两个词」，那条路径在 align 的单测里锁
    const routes = { uv: fakeUvSpawn("ok", fixtureDenseTranscript()) };
    await ingestAroll(dir, contentId);
    const r = await runPhase(
      ctx("transcribe", {}, routes, {
        deps: {
          spawnImpl: routedSpawn(routes),
          // 原样交回 + 补个句号：标点只进 text，不进 words
          runLoopImpl: fakeRunLoop((msg) => [
            { groups: cleanWindow(msg).map((s) => ({ fromSeg: s.id, toSeg: s.id, text: `${s.text}。` })) },
          ]),
        },
      }),
    );
    expect(r.ok).toBe(true);
    const vdir = videoDir(dir, contentId);
    const clean = await readVersioned<TranscriptClean>(vdir, "transcript-clean", 1);
    expect(clean?.warning).toBeUndefined();
    expect(clean?.segments.map((s) => [s.id, s.text])).toEqual([
      ["cseg-0001", "今天聊聊效率。"],
      ["cseg-0002", "今天聊聊效率。"],
    ]);
    // 标点没进 words（字幕消费 words，所以今天烧的字幕不会因为清洗多出标点）
    expect(clean?.segments[1].words.map((w) => w.w)).toEqual([..."今天聊聊效率"]);
    // 事实一个字都没动
    const transcript = await readVersioned<VideoTranscript>(vdir, "transcript", 1);
    expect(transcript?.segments.map((s) => s.id)).toEqual(["seg-0001", "seg-0002"]);
    // 追溯链：这一版选段与单元表勾的是 clean.v1 的分句
    const cut = await readVersioned<VideoCut>(vdir, "cut", 1);
    expect(cut).toMatchObject({ cleanRevision: 1, keeps: ["cseg-0001", "cseg-0002"] });
    const units = await readVersioned<VideoEditUnits>(vdir, "edit-units", 1);
    expect(units?.segments.map((s) => s.id)).toEqual(["cseg-0001", "cseg-0002"]);
  });

  it("稿件没有正文 → 跳过清洗（没稿子就只剩凭空猜错字），clean 原样复制 + 一句说明", async () => {
    contentId = (await seedVideoContent(dir, { body: "" })).contentId;
    await ingestAroll(dir, contentId);
    await runPhase(ctx("transcribe", {}, { uv: fakeUvSpawn("ok") }, { deps: { spawnImpl: routedSpawn({ uv: fakeUvSpawn("ok") }), runLoopImpl: throwingRunLoop("不该被调到") } }));
    const clean = await readVersioned<TranscriptClean>(videoDir(dir, contentId), "transcript-clean", 1);
    // 面板上「文字 v1」摆着而一个错字没纠——不说为什么，人会以为清洗跑过了
    expect(clean?.warning).toContain("没有正文");
    expect(clean?.segments.map((s) => s.id)).toEqual(["seg-0001", "seg-0002"]);
  });
});

/**
 * ASR 结果缓存（转写纠错 spec §2）：14 分钟素材的推理不该为了「重试一次清洗」再跑一遍。
 * 缓存必须保守——宁可白跑一次 ASR，也不能拿另一条素材的转写当这条的事实。
 */
describe("transcribe 的 ASR 缓存", () => {
  const vdir = () => videoDir(dir, contentId);

  /** 让 uv 一被调起就失败：命中缓存的那一跑压根不该碰它 */
  const forbiddenUv = { uv: fakeUvSpawn("crash") };

  async function first(): Promise<void> {
    await ingestAroll(dir, contentId);
    await runPhase(ctx("transcribe"));
  }

  it("指纹与参数都对得上 → 跳过 ffmpeg/ASR 直接用缓存，并把命中说出来", async () => {
    await first();
    const logs: string[] = [];
    const r = await runPhase(
      ctx("transcribe", { transcript: 1, clean: 1, cut: 1 }, forbiddenUv, { report: (m) => logs.push(m) }),
    );
    expect(r.ok).toBe(true);
    expect(logs.join("\n")).toContain("复用已有 ASR 结果");
    expect((await readVersioned<VideoTranscript>(vdir(), "transcript", 2))?.segments).toHaveLength(2);
  });

  it("A-roll 换了 → meta 对不上，老老实实重跑 ASR", async () => {
    await first();
    // 改素材再重新登记：指纹变了，缓存就该失效
    await fs.appendFile(path.join(dir, "contents", contentId, "assets", "aroll.mp4"), Buffer.alloc(2048, 7));
    await ingestAroll(dir, contentId);
    const r = await executePhase(ctx("transcribe", { transcript: 1, clean: 1, cut: 1 }, forbiddenUv));
    expect(r.ok === false && r.errorCode).toBe("asr_exit_1");
  });

  it("meta 损坏（崩在写一半）→ 当没命中，不拿半份缓存冒充事实", async () => {
    await first();
    await fs.writeFile(path.join(vdir(), ASR_META_FILE), "{ 半个 JSON", "utf-8");
    const r = await executePhase(ctx("transcribe", { transcript: 1, clean: 1, cut: 1 }, forbiddenUv));
    expect(r.ok === false && r.errorCode).toBe("asr_exit_1");
  });

  it("meta 对得上但裸输出被截断 → 同样当没命中", async () => {
    await first();
    const raw = await fs.readFile(path.join(vdir(), ASR_OUT_FILE), "utf-8");
    await fs.writeFile(path.join(vdir(), ASR_OUT_FILE), raw.slice(0, raw.length / 2), "utf-8");
    const r = await executePhase(ctx("transcribe", { transcript: 1, clean: 1, cut: 1 }, forbiddenUv));
    expect(r.ok === false && r.errorCode).toBe("asr_exit_1");
  });

  /**
   * 写协议：先作废 → 重算 → 再登记。换了素材、ASR 又崩在半路时，旧 meta 必须已经不在了——
   * 留着它就等于留下一份「meta 说是这条素材、asr-out.json 却是另一条」的错配缓存。
   */
  it("换素材后重跑 ASR 崩了 → meta 已先作废，不留错配缓存", async () => {
    await first();
    await fs.appendFile(path.join(dir, "contents", contentId, "assets", "aroll.mp4"), Buffer.alloc(2048, 7));
    await ingestAroll(dir, contentId);
    await executePhase(ctx("transcribe", { transcript: 1, clean: 1, cut: 1 }, { uv: fakeUvSpawn("crash") }));
    await expect(fs.access(path.join(vdir(), ASR_META_FILE))).rejects.toThrow();
  });
});

describe("cut（AI 粗剪）", () => {
  // cut 段尾接门内预览渲染，所以 npm 也必须路由到假 CLI——否则会去起真的 Remotion
  const dense = { uv: fakeUvSpawn("ok", fixtureDenseTranscript()), npm: fakeRenderSpawn() };

  /** 产物先落 staging，定版本是 runner 在 CAS 之后的事（spec §3.3） */
  async function staged<T>(base: string): Promise<T> {
    const file = path.join(videoDir(dir, contentId), `${base}.vjob-test.staging.json`);
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  }

  async function upToCut(routes = dense): Promise<void> {
    await ingestAroll(dir, contentId);
    await runPhase(ctx("transcribe", {}, routes));
  }

  beforeEach(async () => {
    contentId = (await seedVideoContent(dir, { body: "今天聊聊效率" })).contentId;
  }, 60_000);

  it("模型给出 drop → 按词区间重分单元，keeps 是补集，时间戳原样搬运", async () => {
    await upToCut();
    const drops = [{ startWord: 0, endWordExclusive: 3, flag: "repeat", quote: "今天聊" }];
    const r = await executePhase(
      ctx("cut", { transcript: 1, cut: 1 }, dense, { deps: { spawnImpl: routedSpawn(dense), runLoopImpl: fakeRunLoop([{ drops }]) } }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "cut", state: "awaiting_human" });
    expect(r.ok && r.revisions).toEqual({ cut: 2 });
    expect(stepWarning(r)).toBeUndefined();
    expect(r.ok && r.staged).toEqual([
      { base: "edit-units", revision: 2 },
      { base: "cut", revision: 2 },
    ]);

    const units = await staged<VideoEditUnits>("edit-units");
    // 切点 = drop 边界 ∪ 分句边界 → [0,3) [3,6) [6,12)
    expect(units.origin).toBe("llm");
    expect(units.segments.map((s) => [s.startMs, s.endMs])).toEqual([[0, 300], [300, 600], [1000, 1600]]);
    expect(units.suggestedDrops).toEqual(["unit-0001"]);
    expect(units.flags).toEqual([{ segmentId: "unit-0001", flag: "repeat" }]);
    expect(units.provenance?.promptVersion).toBeTruthy();

    const cut = await staged<VideoCut>("cut");
    expect(cut).toMatchObject({ origin: "llm", baseCutRevision: 1, keeps: ["unit-0002", "unit-0003"] });
  }, 60_000);

  it("模型一次工具都没调 → 全留版 + warning，照常进人工门（不 failed）", async () => {
    await upToCut();
    const r = await executePhase(
      ctx("cut", { transcript: 1, cut: 1 }, dense, { deps: { spawnImpl: routedSpawn(dense), runLoopImpl: fakeRunLoop([]) } }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "cut", state: "awaiting_human" });
    expect(stepWarning(r)).toContain("没调用 submit_rough_cut");
    const units = await staged<VideoEditUnits>("edit-units");
    expect(units).toMatchObject({ origin: "raw", suggestedDrops: [] });
    expect(units.segments.map((s) => s.id)).toEqual(["seg-0001", "seg-0002"]);
    expect((await staged<VideoCut>("cut")).keeps).toEqual(["seg-0001", "seg-0002"]);
  }, 60_000);

  it("模型调用炸了 → 全留版 + warning，不 failed 也不 blocked", async () => {
    await upToCut();
    const r = await executePhase(
      ctx("cut", { transcript: 1, cut: 1 }, dense, {
        deps: { spawnImpl: routedSpawn(dense), runLoopImpl: throwingRunLoop("端点 502") },
      }),
    );
    expect(r.ok).toBe(true);
    expect(stepWarning(r)).toContain("502");
    expect((await staged<VideoEditUnits>("edit-units")).origin).toBe("raw");
  }, 60_000);

  it("引擎未配置 → 全留版 + warning，绝不 blocked（V0b 的缺失不许弄坏 V0a）", async () => {
    await upToCut();
    await fs.rm(path.join(dir, "engine.json"), { force: true });
    const r = await executePhase(ctx("cut", { transcript: 1, cut: 1 }, dense));
    expect(r.ok).toBe(true);
    expect(r.ok === false && r.blockedReason).toBeFalsy();
    expect(stepWarning(r)).toContain("引擎未配置");
  }, 60_000);

  it("词流不健康（词时间戳覆盖不足）→ 跳过 AI，全留版 + warning", async () => {
    await upToCut({ uv: fakeUvSpawn("ok") }); // 默认夹具的「聊聊」没有词时间戳
    const r = await executePhase(ctx("cut", { transcript: 1, cut: 1 }));
    expect(stepWarning(r)).toContain("覆盖率");
    expect((await staged<VideoEditUnits>("edit-units")).origin).toBe("raw");
  }, 60_000);

  it("人工已提交终裁 → 拒绝覆盖，不产新版本", async () => {
    await upToCut();
    await writeVersioned(videoDir(dir, contentId), "cut", 2, {
      transcriptRevision: 1,
      keeps: ["seg-0001"],
      flags: [],
      origin: "human",
    });
    const r = await executePhase(ctx("cut", { transcript: 1, cut: 2 }, dense));
    expect(r.ok && r.revisions).toBeUndefined();
    expect(stepWarning(r)).toContain("人工确认");
  }, 60_000);

  it("读不到转写 → missing_input（这个是真失败，不是降级）", async () => {
    const r = await executePhase(ctx("cut", { transcript: 9, cut: 1 }, dense));
    expect(r.ok === false && r.errorCode).toBe("missing_input");
  }, 60_000);

  // v2 spec §4.1：粗剪 LLM → 预览渲染在同一个运行段里顺序做完
  it("尾接门内预览：产物就位、preview 指针带回给 runner", async () => {
    await upToCut();
    const r = await executePhase(ctx("cut", { transcript: 1, cut: 1 }, dense));
    expect(r.ok).toBe(true);
    expect(r.ok && r.preview).toEqual({ requestedRevision: 1, readyRevision: 1 });
    await fs.access(path.join(videoDir(dir, contentId), "preview.v1.mp4"));
    await fs.access(path.join(videoDir(dir, contentId), "cut-preview-request.v1.json"));
  }, 60_000);

  // 边界 #1：预览渲染失败，门照开
  it("预览渲染失败 → 仍停人工门，失败原因写进 preview.error", async () => {
    await upToCut();
    const routes = { ...dense, npm: fakeRenderSpawn({ exitCode: 1 }) };
    const r = await executePhase(ctx("cut", { transcript: 1, cut: 1 }, routes));
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "cut", state: "awaiting_human" });
    expect(r.ok && r.preview?.readyRevision).toBeUndefined();
    expect(r.ok && r.preview?.error).toContain("预览渲染退出码");
  }, 60_000);

  it("人已终裁的那版：建议不覆盖，但预览照出（门上没片可看才是最糟的）", async () => {
    await upToCut();
    await writeVersioned(videoDir(dir, contentId), "cut", 2, {
      transcriptRevision: 1,
      keeps: ["seg-0001"],
      flags: [],
      origin: "human",
    });
    const r = await executePhase(ctx("cut", { transcript: 1, cut: 2 }, dense));
    expect(stepWarning(r)).toContain("已由人工确认");
    expect(r.ok && r.preview).toEqual({ requestedRevision: 1, readyRevision: 1 });
  }, 60_000);
});

describe("edit（剪辑师 agent）", () => {
  /** 60 秒成片：掐掉开头 30s / 结尾 15s 后还剩 [30000, 45000] 这段合法窗口 */
  const overlay = { assetId: "b1", outputStartMs: 32_000, durationMs: 2_000, inMs: 500, outMs: 2_500 };

  async function staged<T>(base: string): Promise<T> {
    const file = path.join(videoDir(dir, contentId), `${base}.vjob-test.staging.json`);
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  }

  /** 直接种转写与选段：这里测的是剪辑师那一步，前面几步与它无关 */
  async function seedCut(): Promise<void> {
    const vdir = videoDir(dir, contentId);
    await writeVersioned(vdir, "transcript", 1, fixtureLongTranscript());
    await writeVersioned(vdir, "cut", 1, {
      transcriptRevision: 1,
      keeps: ["seg-0001", "seg-0002"],
      flags: [],
      origin: "human",
    });
  }

  function editCtx(turns: Array<Record<string, unknown>>, revisions: VideoState["revisions"] = { transcript: 1, cut: 1 }) {
    return ctx("edit", revisions, { uv: fakeUvSpawn("ok") }, {
      deps: { spawnImpl: routedSpawn({ uv: fakeUvSpawn("ok") }), runLoopImpl: fakeRunLoop(turns) },
    });
  }

  beforeEach(async () => {
    contentId = (await seedVideoContent(dir, { body: "【开场】今天聊聊效率\n【演示】你看这个界面" })).contentId;
    await seedCut();
  });

  it("模型给出编排 → plan 落 staging，停在成片计划的人工门", async () => {
    await seedBrollAsset(dir, contentId);
    const r = await executePhase(editCtx([{ overlays: [overlay] }]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "edit", state: "awaiting_human" });
    expect(r.ok && r.revisions).toEqual({ editor: 1 });
    expect(r.ok && r.staged).toEqual([{ base: "editor-plan", revision: 1 }]);
    expect(stepWarning(r)).toBeUndefined();

    const plan = await staged<VideoEditorPlan>("editor-plan");
    expect(plan).toMatchObject({ schemaVersion: 1, cutRevision: 1, origin: "llm" });
    expect(plan.overlays[0]).toMatchObject({
      overlayId: "ov-01",
      outputStartMs: 32_000,
      durationMs: 2_000,
      inMs: 500,
      outMs: 2_500,
      label: "屏录：产品界面演示",
      source: { kind: "asset", type: "screen", name: "screen.mp4", ref: { kind: "content", filename: "screen.mp4" } },
    });
    // 指纹在剪辑师选中的那一刻就打好，assemble 复检对着它（边界 #12）
    const snapshot = plan.overlays[0]!.source;
    expect(snapshot.kind === "asset" && snapshot.fingerprint.quickHash).toBeTruthy();
    expect(plan.provenance?.promptVersion).toBeTruthy();
  });

  it("重跑 → editor revision 递增（cut 号不动，产物不会撞车）", async () => {
    await seedBrollAsset(dir, contentId);
    const r = await executePhase(editCtx([{ overlays: [] }], { transcript: 1, cut: 1, editor: 3 }));
    expect(r.ok && r.revisions).toEqual({ editor: 4 });
  });

  // v2 spec §4.2：零素材短路已删——剪辑师照样跑，可以全提 generate 槽
  it("稿件零 broll 素材 → 模型照跑，全 generate 槽也停人工门", async () => {
    const gen = { description: "暗底细网格上数字滚动 80%→20%，克制", mediaKind: "video", outputStartMs: 32_000, durationMs: 2_000 };
    const r = await executePhase(editCtx([{ overlays: [gen] }]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "edit", state: "awaiting_human" });
    expect(stepWarning(r)).toBeUndefined();
    const plan = await staged<VideoEditorPlan>("editor-plan");
    expect(plan).toMatchObject({ origin: "llm" });
    expect(plan.overlays[0]!.source).toMatchObject({ kind: "generate", mediaKind: "video" });
  });

  it("素材全都没写说明 → 空 plan + 面板点名被排除的素材（边界 #3）", async () => {
    await seedBrollAsset(dir, contentId, { filename: "nodesc.mp4", description: "" });
    const r = await executePhase(editCtx([]));
    expect(r.ok).toBe(true);
    const plan = await staged<VideoEditorPlan>("editor-plan");
    expect(plan.origin).toBe("empty");
    expect(plan.excludedAssets?.join()).toContain("nodesc.mp4（没写说明）");
  });

  it("模型调用炸了 → 空 plan + warning，照常进人工门（不 failed 也不 blocked）", async () => {
    await seedBrollAsset(dir, contentId);
    const r = await executePhase(
      ctx("edit", { transcript: 1, cut: 1 }, { uv: fakeUvSpawn("ok") }, {
        deps: { spawnImpl: routedSpawn({ uv: fakeUvSpawn("ok") }), runLoopImpl: throwingRunLoop("端点 502") },
      }),
    );
    expect(r.ok).toBe(true);
    expect(stepWarning(r)).toContain("502");
    expect((await staged<VideoEditorPlan>("editor-plan")).origin).toBe("empty");
  });

  it("读不到选段 → missing_input（这个是真失败，不是降级）", async () => {
    const r = await executePhase(editCtx([], { transcript: 1, cut: 9 }));
    expect(r.ok === false && r.errorCode).toBe("missing_input");
    expect(r.ok === false && r.reason).toContain("cut.v9");
  });
});

describe("assemble / render 的输入缺失", () => {
  it("读不到 transcript/cut → missing_input，点名版本号", async () => {
    await ingestAroll(dir, contentId);
    const r = await executePhase(ctx("assemble", { transcript: 7, cut: 9 }));
    expect(r.ok === false && r.errorCode).toBe("missing_input");
    expect(r.ok === false && r.reason).toContain("transcript.v7");
  });

  it("读不到 manifest → missing_manifest，指引重新组装", async () => {
    const r = await executePhase(ctx("render", { timeline: 3 }));
    expect(r.ok === false && r.errorCode).toBe("missing_manifest");
    expect(r.ok === false && r.reason).toContain("重新组装");
  });
});
