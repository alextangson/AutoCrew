/**
 * 渲染层冒烟：**真跑全链**（spec §11：render CLI 以短 manifest 真渲染 + ffprobe 断言，进本地 check 门）。
 *
 *   npm --prefix render run smoke
 *
 * 步骤：系统 ffmpeg 合素材 → 生成 render-manifest → 跑 CLI → ffprobe 断言。
 * 任一断言失败 → 非零退出。产物落 render/out/（已 gitignore）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDER_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = path.join(RENDER_ROOT, 'out');
const FIXTURE_DIR = path.join(OUT_DIR, 'smoke-fixtures');
const OUT_FILE = path.join(OUT_DIR, 'smoke.mp4');
const REGISTRY_FIXTURE = path.join(RENDER_ROOT, 'test-fixtures/timeline-registry.json');

const TOTAL_MS = 3000;
const FPS = 30;
/** 视频线唯一画幅（横屏 spec §0）。 */
const WIDTH = 1920;
const HEIGHT = 1080;

const failures: string[] = [];

function log(message: string): void {
  console.log(message);
}

function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    log(`  ✓ ${label}：${detail}`);
  } else {
    log(`  ✗ ${label}：${detail}`);
    failures.push(`${label} → ${detail}`);
  }
}

function run(cmd: string, args: string[], label: string): void {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`${label} 执行失败（${cmd} 不可用？）：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} 退出码 ${result.status}\n${result.stderr}`);
  }
}

// ---- 1. 素材 -------------------------------------------------------------
function buildFixtures(): { aroll: string; audio: string; image: string } {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });

  const aroll = path.join(FIXTURE_DIR, 'aroll.mp4');
  const audio = path.join(FIXTURE_DIR, 'anchor.wav');
  const image = path.join(FIXTURE_DIR, 'shot.png');

  log('[1/4] 用系统 ffmpeg 合成素材…');
  run(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=4`,
     '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '4', aroll],
    'ffmpeg 合成 A-roll',
  );
  run(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
     '-c:a', 'pcm_s16le', audio],
    'ffmpeg 合成锚音轨',
  );
  run(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2b6cb0:size=1080x1080:duration=1',
     '-frames:v', '1', image],
    'ffmpeg 合成图片',
  );
  return { aroll, audio, image };
}

// ---- 2. manifest ---------------------------------------------------------
function buildManifest(assets: { aroll: string; audio: string; image: string }): string {
  const manifest = {
    schemaVersion: 2,
    contentId: 'smoke-content',
    timelineRevision: 1,
    cutRevision: 1,
    transcriptRevision: 1,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    durationMs: TOTAL_MS,
    anchorAudio: { file: assets.audio, durationMs: TOTAL_MS },
    arollVideo: {
      file: assets.aroll,
      segments: [
        { sourceStartMs: 0, sourceEndMs: 1500, outputStartMs: 0 },
        { sourceStartMs: 2000, sourceEndMs: 3500, outputStartMs: 1500 },
      ],
    },
    overlays: [
      {
        clipId: 'ov-code',
        outputStartMs: 300,
        durationMs: 1100,
        kind: 'graphic',
        template: 'code-block',
        props: { code: 'const crew = await build();\nreturn crew.render();', lang: 'ts' },
        transition: 'fade',
      },
      {
        clipId: 'ov-screen',
        outputStartMs: 1500,
        durationMs: 600,
        kind: 'screen',
        file: assets.aroll,
        inMs: 0,
        outMs: 600,
        // 不写 fit：走 screen 的默认 contain（横屏 spec §2.5）
        transition: 'cut',
      },
      {
        clipId: 'ov-image',
        outputStartMs: 2200,
        durationMs: 700,
        kind: 'image',
        file: assets.image,
        // 不写 fit：1080×1080 的图在 1920×1080 画布上应当留左右黑边（默认 contain）
        transition: 'fade',
      },
    ],
    captions: {
      style: 'word-highlight',
      words: [
        { w: '这条', startMs: 0, endMs: 400 },
        { w: '视频', startMs: 400, endMs: 900 },
        { w: '讲', startMs: 900, endMs: 1200 },
        { w: 'FDE', startMs: 1200, endMs: 1800 },
        { w: '怎么', startMs: 1800, endMs: 2300 },
        { w: '落地', startMs: 2300, endMs: 3000 },
      ],
      emphasisWords: ['FDE'],
    },
    titleCard: { template: 'hook-title', text: 'FDE 是怎么落地的', durationMs: 1200 },
    identity: {
      captionTheme: { fontFamily: 'PingFang SC', primaryColor: '#ffffff', emphasisColor: '#ffd60a' },
      codeTheme: { background: '#0d1117', foreground: '#e6edf3', accent: '#7ee787' },
    },
    provenance: { hasAiClips: false, hasClonedVoice: false },
  };

  const file = path.join(FIXTURE_DIR, 'render-manifest.json');
  writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');

  // 边界 #11：v1 竖屏产物必须被 zod 拒绝，且拒绝理由是人话。
  const legacy = { ...manifest, schemaVersion: 1, width: 1080, height: 1920 };
  writeFileSync(path.join(FIXTURE_DIR, 'render-manifest.v1.json'), JSON.stringify(legacy, null, 2), 'utf8');
  return file;
}

/** 拿一份 v1 竖屏 manifest 撞校验：必须非零退出，且 stderr 说清「重新确认选段以重组装」。 */
async function checkLegacyRejected(): Promise<void> {
  const legacyPath = path.join(FIXTURE_DIR, 'render-manifest.v1.json');
  const cli = await runCli(legacyPath, path.join(OUT_DIR, 'smoke-legacy.mp4'));
  check('v1 竖屏 manifest 被拒', cli.code !== 0, `退出码 ${cli.code}`);
  check(
    'v1 拒绝理由是人话',
    cli.stderr.includes('重新确认选段以重组装'),
    cli.stderr.trim().split('\n').slice(-3).join(' | ') || '（无 stderr）',
  );
}

// ---- 3. 跑 CLI -----------------------------------------------------------
type CliResult = { stdout: string; stderr: string; code: number; elapsedMs: number };

function runCli(manifestPath: string, outFile: string = OUT_FILE): Promise<CliResult> {
  const tsx = path.join(RENDER_ROOT, 'node_modules/.bin/tsx');
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      tsx,
      ['src/cli.ts', '--manifest', manifestPath, '--out', outFile, '--registry', REGISTRY_FIXTURE],
      { cwd: RENDER_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ stdout, stderr, code: code ?? -1, elapsedMs: Date.now() - startedAt }),
    );
  });
}

// ---- 4. ffprobe 断言 -----------------------------------------------------
type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
};

function ffprobe(file: string): { streams: ProbeStream[]; format: { duration?: string } } {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe 读不了成片：${file}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function parseRate(rate: string | undefined): number {
  if (!rate) return NaN;
  const [num, den] = rate.split('/').map(Number);
  if (!den) return NaN;
  return num! / den!;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(OUT_FILE, { force: true });

  const assets = buildFixtures();
  const manifestPath = buildManifest(assets);
  log(`[2/4] manifest 写入 ${manifestPath}`);
  await checkLegacyRejected();

  log('[3/4] 跑渲染 CLI（首次会下载 Chrome Headless Shell，属预期）…');
  const cli = await runCli(manifestPath);
  log(`      CLI 退出码 ${cli.code}，耗时 ${(cli.elapsedMs / 1000).toFixed(1)}s`);
  log('      ---- CLI stdout ----');
  log(
    cli.stdout
      .trimEnd()
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n'),
  );

  log('[4/4] 断言…');
  check('CLI 退出码', cli.code === 0, String(cli.code));

  const lines = cli.stdout.split('\n').filter((l) => l.trim().length > 0);
  let allJson = true;
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      allJson = false;
      log(`      非 JSON 的 stdout 行：${line}`);
    }
  }
  check('stdout 全是 JSON lines', allJson && lines.length > 0, `${lines.length} 行`);
  const done = parsed.find((p) => p.type === 'done');
  check('收到 done 行', Boolean(done) && done?.outFile === OUT_FILE, JSON.stringify(done ?? null));
  const progress = parsed.filter((p) => p.type === 'progress');
  const lastProgress = progress[progress.length - 1];
  check(
    'progress 行覆盖到最后一帧',
    progress.length > 0 && lastProgress?.renderedFrames === lastProgress?.totalFrames,
    `${progress.length} 条，末条 ${JSON.stringify(lastProgress ?? null)}`,
  );

  if (cli.code !== 0) {
    log('CLI 失败，跳过 ffprobe 断言。');
  } else {
    const probe = ffprobe(OUT_FILE);
    const video = probe.streams.find((s) => s.codec_type === 'video');
    const audio = probe.streams.find((s) => s.codec_type === 'audio');
    const duration = Number(probe.format.duration ?? NaN);

    check('视频编码 h264', video?.codec_name === 'h264', String(video?.codec_name));
    check(
      `画幅 ${WIDTH}×${HEIGHT}（横屏）`,
      video?.width === WIDTH && video?.height === HEIGHT,
      `${video?.width}×${video?.height}`,
    );
    check('帧率 30fps', parseRate(video?.r_frame_rate) === FPS, String(video?.r_frame_rate));
    check(
      `时长 ${TOTAL_MS / 1000}s ±0.2s`,
      Math.abs(duration - TOTAL_MS / 1000) <= 0.2,
      `${duration.toFixed(3)}s`,
    );
    check('含 aac 音轨', audio?.codec_name === 'aac', String(audio?.codec_name));
    log(`      成片：${OUT_FILE}`);
  }

  if (failures.length > 0) {
    log(`\n冒烟失败（${failures.length} 项）：`);
    for (const f of failures) log(`  · ${f}`);
    process.exit(1);
  }
  log(`\n冒烟全过 ✅  渲染耗时 ${(cli.elapsedMs / 1000).toFixed(1)}s`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
