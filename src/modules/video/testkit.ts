/**
 * 视频线测试夹具（**只被 *.test.ts 引用**，不参与生产代码）。
 *
 * 分工是刻意的（spec §11 测试策略）：
 * - **ffmpeg/ffprobe 用真的**：3 秒 testsrc2 + sine 合成的 mp4 当 A-roll，缓存在 os.tmpdir。
 *   响度归一、时长断言这些东西 mock 掉就等于没测。
 * - **ASR 用假的**：真 FunASR 要 1GB 模型 + 几十秒推理，契约测试只需要「进程怎么退出」。
 * - **render 用假的，但产物是真的**：假 CLI 调真 ffmpeg 生成合法的 1920×1080@30 mp4，
 *   于是 render-exec 的 ffprobe 断言是真断言，不是自问自答。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { addAsset, saveContent, type AssetRole } from "../../storage/local-store.js";
import type { runLoop } from "../../engine/loop.js";
import { runProcess } from "./proc.js";
import type { VideoTranscript } from "./types.js";

// ---------------------------------------------------------------------------
// A-roll 夹具
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(os.tmpdir(), "autocrew-video-fixtures");
const AROLL_FIXTURE = path.join(FIXTURE_DIR, "aroll-3s.mp4");
const BGM_FIXTURE = path.join(FIXTURE_DIR, "bgm-5s.wav");

/** 3 秒 640×360 测试图 + 440Hz 正弦音轨。合成一次缓存复用（每个测试重合成太慢） */
export async function ensureArollFixture(): Promise<string> {
  try {
    await fs.access(AROLL_FIXTURE);
    return AROLL_FIXTURE;
  } catch {
    /* 还没合成过 */
  }
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  const result = await runProcess({
    command: "ffmpeg",
    args: [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", AROLL_FIXTURE,
    ],
    timeoutMs: 60_000,
  });
  if (result.code !== 0) throw new Error(`合成 A-roll 夹具失败：${result.stderr}`);
  return AROLL_FIXTURE;
}

/** 5 秒 220Hz 正弦当 BGM：比 anchor 长，混音链的 loop/截断分支才有东西可截 */
export async function ensureBgmFixture(): Promise<string> {
  try {
    await fs.access(BGM_FIXTURE);
    return BGM_FIXTURE;
  } catch {
    /* 还没合成过 */
  }
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  const result = await runProcess({
    command: "ffmpeg",
    args: ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=5", "-c:a", "pcm_s16le", BGM_FIXTURE],
    timeoutMs: 60_000,
  });
  if (result.code !== 0) throw new Error(`合成 BGM 夹具失败：${result.stderr}`);
  return BGM_FIXTURE;
}

/** 与 3 秒夹具对齐的两句转写：keep 全部 → 输出域 2000ms */
export function fixtureTranscript(): VideoTranscript {
  return {
    schemaVersion: 1,
    source: "funasr",
    segments: [
      {
        id: "seg-0001",
        text: "今天聊聊 FDE",
        startMs: 0,
        endMs: 1000,
        words: [
          { w: "今", startMs: 0, endMs: 200 },
          { w: "天", startMs: 200, endMs: 400 },
          { w: "FDE", startMs: 400, endMs: 1000 },
        ],
      },
      {
        id: "seg-0002",
        text: "这是第二句",
        startMs: 1500,
        endMs: 2500,
        words: [
          { w: "这", startMs: 1500, endMs: 1800 },
          { w: "是", startMs: 1800, endMs: 2100 },
          { w: "第二句", startMs: 2100, endMs: 2500 },
        ],
      },
    ],
  };
}

/**
 * 词覆盖完整的两句转写（每个词恰好对上 text 里的一个字）。
 * `fixtureTranscript` 的「聊聊」没有词时间戳，覆盖率只有 83%，会被粗剪的前置健康检查
 * 挡在门外——那条路径也要测，但走 AI 分支时得用这一份。
 */
export function fixtureDenseTranscript(): VideoTranscript {
  const word = (w: string, startMs: number, endMs: number) => ({ w, startMs, endMs });
  return {
    schemaVersion: 1,
    source: "funasr",
    segments: [
      {
        id: "seg-0001",
        text: "今天聊聊效率",
        startMs: 0,
        endMs: 600,
        words: [word("今", 0, 100), word("天", 100, 200), word("聊", 200, 300), word("聊", 300, 400), word("效", 400, 500), word("率", 500, 600)],
      },
      {
        id: "seg-0002",
        text: "今天聊聊效率",
        startMs: 1000,
        endMs: 1600,
        words: [word("今", 1000, 1100), word("天", 1100, 1200), word("聊", 1200, 1300), word("聊", 1300, 1400), word("效", 1400, 1500), word("率", 1500, 1600)],
      },
    ],
  };
}

/**
 * 一条「够长」的转写：输出域 60 秒，掐掉开头 30s / 结尾 15s 之后还剩 15 秒合法窗口。
 * 剪辑师的禁区规则让短片子根本排不下 B-roll，测编排就必须有这么一份。
 * 注意它对应的 A-roll 夹具只有 3 秒——**只能用来测不碰媒体的步骤**（edit phase、plan 确认）。
 */
export function fixtureLongTranscript(): VideoTranscript {
  const seg = (id: string, text: string, startMs: number, endMs: number) => ({
    id,
    text,
    startMs,
    endMs,
    words: [...text].map((w, i, all) => ({
      w,
      startMs: startMs + Math.round(((endMs - startMs) * i) / all.length),
      endMs: startMs + Math.round(((endMs - startMs) * (i + 1)) / all.length),
    })),
  });
  return {
    schemaVersion: 1,
    source: "funasr",
    segments: [
      seg("seg-0001", "先讲清楚这件事为什么重要", 0, 30_000),
      seg("seg-0002", "你看这个界面我演示一下流程", 30_000, 60_000),
    ],
  };
}

export type FakeTurns = Array<Record<string, unknown>>;

/**
 * 假 runLoop —— **测试绝不真调模型**。按 `turns` 里的参数依次调第一个工具；
 * 工具返回 `Error:` 开头的串就相当于模型被打回，继续下一轮（自纠语义）。
 * `turns` 为空 = 模型一次工具都没调。
 *
 * 传函数形态可以按本次调用的 userMessage 决定回什么——粗剪分窗后每次调用只看一段词流，
 * 分窗测试要靠它给不同窗口不同答案（函数里 throw 就是那一窗调用失败）。
 */
export function fakeRunLoop(turns: FakeTurns | ((userMessage: string) => FakeTurns)): typeof runLoop {
  return (async (_config, opts) => {
    const tool = opts.tools?.[0];
    const plan = typeof turns === "function" ? turns(opts.userMessage) : turns;
    const outputs: string[] = [];
    for (const args of plan.slice(0, opts.maxTurns ?? 6)) {
      if (!tool) break;
      outputs.push(await tool.execute(args));
    }
    return {
      finalMessage: outputs.at(-1) ?? "",
      turns: outputs.length,
      totalTokens: 0,
      toolCallCount: outputs.length,
      stopReason: "no_tool_calls",
    };
  }) as typeof runLoop;
}

/** 从粗剪的 userMessage 里读出本次窗口的合法索引区间（分窗测试用） */
export function windowOf(userMessage: string): { from: number; to: number } {
  const m = /合法索引区间 \[(\d+), (\d+)\)/.exec(userMessage);
  if (!m) throw new Error(`userMessage 里找不到窗口区间：${userMessage.slice(0, 200)}`);
  return { from: Number(m[1]), to: Number(m[2]) };
}

/** 模型调用直接炸（无 key / 端点挂了）——降级必须可见，不许被吞 */
export function throwingRunLoop(message: string): typeof runLoop {
  return (() => Promise.reject(new Error(message))) as typeof runLoop;
}

/**
 * 种一份引擎配置。**测试必须显式种它**：否则 `loadEngineConfig` 会去读
 * `process.env.DEEPSEEK_API_KEY`，跑测试的人配没配 key 会让结果不一样。
 * baseUrl 指向不可解析的域名，就算哪天真调了也打不出去。
 */
export async function seedEngineConfig(dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "engine.json"),
    JSON.stringify({ apiKey: "test-key", baseUrl: "https://engine.invalid", strongModel: "test-strong" }),
    "utf-8",
  );
}

/**
 * 夹具缓存是跨测试文件共享的，而 addAsset 按硬链接落盘（生产语义）。
 * 直接拿共享缓存当挂接源，「模拟素材漂移」的用例 appendFile 改自己稿件里的
 * aroll.mp4 时会写穿链接、污染共享缓存，并发中的其他测试随即集体 aroll_drifted。
 * 所以种子一律先复制出本测试私有的一份，硬链接两端都落在本测试的 dataDir 里。
 * 复制前先 rm 断掉可能存在的旧链接——copyFile 的截断写同样会写穿。
 */
async function stageFixture(fixture: string, dataDir: string, name: string): Promise<string> {
  const staged = path.join(dataDir, "fixture-src", name);
  await fs.mkdir(path.dirname(staged), { recursive: true });
  await fs.rm(staged, { force: true });
  await fs.copyFile(fixture, staged);
  return staged;
}

/**
 * 稿件 + A-roll 素材一把种好；返回 contentId 与 A-roll 在稿件里的绝对路径。
 *
 * A-roll 默认带 `role: "aroll"`——那是横屏 spec §2.6 之后的正路。要测老稿件的
 * 「第一个 video」回落，把 `arollRole` 传 `null` 显式种一份无角色数据。
 */
export async function seedVideoContent(
  dataDir: string,
  overrides?: {
    status?: "approved" | "published" | "draft_ready";
    platform?: string;
    body?: string;
    arollRole?: AssetRole | null;
  },
): Promise<{ contentId: string; arollPath: string }> {
  const content = await saveContent(
    {
      title: "FDE 是什么",
      body: overrides?.body ?? "今天聊聊 FDE，这是第二句。",
      platform: overrides?.platform ?? "douyin",
      status: overrides?.status ?? "approved",
      tags: [],
      hashtags: [],
    },
    dataDir,
  );
  const assetsDir = path.join(dataDir, "contents", content.id, "assets");
  await fs.mkdir(assetsDir, { recursive: true });
  const role = overrides?.arollRole === undefined ? "aroll" : overrides.arollRole;
  const source = await stageFixture(await ensureArollFixture(), dataDir, "aroll.mp4");
  const added = await addAsset(
    content.id,
    { filename: "aroll.mp4", type: "video", sourcePath: source, ...(role ? { role } : {}) },
    dataDir,
  );
  if (!added.ok) throw new Error(`种 A-roll 素材失败：${added.error}`);
  return { contentId: content.id, arollPath: path.join(assetsDir, "aroll.mp4") };
}

/**
 * 往稿件里挂一条 B-roll（屏录）。`description` 决定它进不进剪辑师视野——
 * 没说明的素材被排除是横屏 spec §2.6 的兜底规则，测边界时把它传成空串。
 * 文件用的是 3 秒 A-roll 夹具，所以 `durationMs` 默认按真实时长 3000 报。
 */
export async function seedBrollAsset(
  dataDir: string,
  contentId: string,
  overrides?: { filename?: string; description?: string; durationMs?: number; type?: "video" | "image" },
): Promise<string> {
  const filename = overrides?.filename ?? "screen.mp4";
  const type = overrides?.type ?? "video";
  const source = await stageFixture(await ensureArollFixture(), dataDir, filename);
  const description = overrides?.description ?? "屏录：产品界面演示";
  const added = await addAsset(
    contentId,
    {
      filename,
      type,
      role: "broll",
      sourcePath: source,
      ...(description ? { description } : {}),
      ...(type === "video" ? { media: { durationMs: overrides?.durationMs ?? 3000 } } : {}),
    },
    dataDir,
  );
  if (!added.ok) throw new Error(`种 B-roll 素材失败：${added.error}`);
  return path.join(dataDir, "contents", contentId, "assets", filename);
}

/** 往稿件里挂一条 BGM（角色写死 bgm）；返回它在稿件里的绝对路径 */
export async function seedBgmAsset(
  dataDir: string,
  contentId: string,
  filename = "bgm.wav",
): Promise<string> {
  const source = await stageFixture(await ensureBgmFixture(), dataDir, filename);
  const added = await addAsset(contentId, { filename, type: "audio", role: "bgm", sourcePath: source }, dataDir);
  if (!added.ok) throw new Error(`种 BGM 素材失败：${added.error}`);
  return path.join(dataDir, "contents", contentId, "assets", filename);
}

// ---------------------------------------------------------------------------
// 假子进程
// ---------------------------------------------------------------------------

export interface FakeChildOptions {
  /** 依次写入 stdout 的行（自动补换行） */
  stdoutLines?: string[];
  stderr?: string;
  exitCode?: number | null;
  /** 退出前的副作用（写 --out 文件等）；异步会被等待 */
  before?: () => Promise<void> | void;
  /** true = 永不主动退出，只有被 kill 才结束（超时用例） */
  hang?: boolean;
  /** 立刻发 error 事件（模拟 ENOENT：命令根本不存在） */
  spawnError?: string;
}

/**
 * 假 ChildProcess：EventEmitter + 两条 PassThrough。
 * `pid` 故意留空——`killTree` 会因此走 `child.kill()` 而不是对着一个假 pid 发组信号
 * （拿假 pid 去 `process.kill(-pid)` 可能误伤真进程，这是不能出的事故）。
 */
export function fakeChild(opts: FakeChildOptions): ChildProcess {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = emitter as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = stdout;
  child.stderr = stderr;

  let ended = 0;
  let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
  const onEnd = (): void => {
    if (++ended === 2) emitter.emit("close", exit.code, exit.signal);
  };
  stdout.on("end", onEnd);
  stderr.on("end", onEnd);

  let done = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (done) return;
    done = true;
    exit = { code, signal };
    stdout.end();
    stderr.end();
  };
  (child as unknown as { kill: (s?: NodeJS.Signals) => boolean }).kill = (signal) => {
    finish(null, signal ?? "SIGTERM");
    return true;
  };

  setTimeout(() => {
    if (opts.spawnError) {
      emitter.emit("error", new Error(opts.spawnError));
      return;
    }
    void (async () => {
      for (const line of opts.stdoutLines ?? []) stdout.write(`${line}\n`);
      if (opts.stderr) stderr.write(opts.stderr);
      try {
        await opts.before?.();
      } catch (err) {
        stderr.write(String(err));
        finish(1, null);
        return;
      }
      if (!opts.hang) finish(opts.exitCode ?? 0, null);
    })();
  }, 0);

  return child;
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ---------------------------------------------------------------------------
// 假 ASR sidecar
// ---------------------------------------------------------------------------

export type AsrScenario = "ok" | "hang" | "half_file" | "model_missing" | "crash" | "no_output";

/** uv 侧的四种剧本：正常吐 JSON / 挂住不退 / 半个 JSON / 非 0 退出 */
export function fakeUvSpawn(scenario: AsrScenario, transcript?: VideoTranscript): (args: readonly string[]) => ChildProcess {
  return (args) => {
    if (args[0] === "--version") return fakeChild({ stdoutLines: ["uv 0.10.6"] });
    if (args.includes("--warmup")) return fakeChild({ stderr: "[asr] 模型就绪\n" });
    const out = argValue(args, "--out")!;
    const body = JSON.stringify(transcript ?? fixtureTranscript());
    switch (scenario) {
      case "hang":
        return fakeChild({ hang: true, stderr: "[asr] 转写中…\n" });
      case "model_missing":
        return fakeChild({ exitCode: 20, stderr: "[asr] 模型尚未下载\n" });
      case "crash":
        return fakeChild({ exitCode: 1, stderr: "[asr] 失败：RuntimeError: boom\n" });
      case "no_output":
        return fakeChild({ exitCode: 0 });
      case "half_file":
        return fakeChild({ before: () => fs.writeFile(out, body.slice(0, Math.floor(body.length / 2)), "utf-8") });
      default:
        return fakeChild({ before: () => fs.writeFile(out, body, "utf-8"), stderr: "[asr] 完成\n" });
    }
  };
}

// ---------------------------------------------------------------------------
// 假 render CLI（产物是真的）
// ---------------------------------------------------------------------------

export interface FakeRenderOptions {
  /** 让成片故意不合格：改分辨率/帧率/去掉音轨/改时长，用来验 ffprobe 断言真的在拦 */
  width?: number;
  height?: number;
  fps?: number;
  noAudio?: boolean;
  durationDeltaMs?: number;
  exitCode?: number;
  /** 渲染开始后、产出前的钩子（伪造并发写状态用） */
  onStart?: (manifestPath: string) => Promise<void> | void;
}

/**
 * 用真 ffmpeg 生成 mp4 写到 --out，并按契约吐 JSON lines 进度。
 *
 * **认 `--profile`**：真 CLI 在 preview 档走 Remotion `scale: 0.5` 出 960×540，
 * 假 CLI 不跟着减半的话，preview-exec 的 ffprobe 断言就永远在假失败上打转。
 */
export function fakeRenderSpawn(opts: FakeRenderOptions = {}): (args: readonly string[]) => ChildProcess {
  return (args) => {
    const manifestPath = argValue(args, "--manifest")!;
    const out = argValue(args, "--out")!;
    const half = argValue(args, "--profile") === "preview" ? 2 : 1;
    if (opts.exitCode && opts.exitCode !== 0) {
      return fakeChild({ exitCode: opts.exitCode, stderr: "[render] 渲染失败：\nRenderInputError: 假装崩了\n" });
    }
    return fakeChild({
      stdoutLines: ['{"type":"progress","renderedFrames":0,"totalFrames":60}', '{"type":"progress","renderedFrames":60,"totalFrames":60}'],
      before: async () => {
        await opts.onStart?.(manifestPath);
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as { durationMs: number };
        const seconds = ((manifest.durationMs + (opts.durationDeltaMs ?? 0)) / 1000).toFixed(3);
        const size = `${(opts.width ?? 1920) / half}x${(opts.height ?? 1080) / half}`;
        const fps = opts.fps ?? 30;
        const result = await runProcess({
          command: "ffmpeg",
          args: [
            "-y", "-v", "error",
            "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${fps}:duration=${seconds}`,
            ...(opts.noAudio ? [] : ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`]),
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", String(fps),
            ...(opts.noAudio ? [] : ["-c:a", "aac"]), "-shortest", out,
          ],
          timeoutMs: 120_000,
        });
        if (result.code !== 0) throw new Error(`假渲染失败：${result.stderr}`);
      },
    });
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** 命令名 → 假进程工厂；没登记的命令一律走真 spawn（ffmpeg/ffprobe 默认就是真的） */
export type SpawnRoutes = Record<string, (args: readonly string[]) => ChildProcess>;

export function routedSpawn(routes: SpawnRoutes): typeof spawn {
  return ((command: string, args: readonly string[], options: object) => {
    const route = routes[command];
    return route ? route(args) : spawn(command, args, options);
  }) as unknown as typeof spawn;
}

/** 假 ffprobe：直接给一份 JSON 报文，用来测那些造真文件太贵的规则（如 >30 分钟） */
export function fakeFfprobe(payload: unknown): (args: readonly string[]) => ChildProcess {
  return () => fakeChild({ stdoutLines: [JSON.stringify(payload)] });
}
