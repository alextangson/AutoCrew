/**
 * 渲染 CLI（spec §6.1 契约）：
 *   npm --prefix render run render -- --manifest <abs> --out <abs> [--registry <abs>]
 *
 * 纪律：
 * - **stdout 只有 JSON lines**：{"type":"progress",...}（节流 ≥1s）与结尾 {"type":"done",...}。
 *   为此把 process.stdout.write 整体改道到 stderr，只有本文件的 emit() 走原始 stdout——
 *   webpack/Remotion/浏览器日志再怎么打印都污染不了调用方的解析。
 * - 一切错误走 stderr + exit 1；无静默降级。
 * - 直接写 --out 指定路径；tmp/rename 事务边界（spec §6.2）是调用方的事。
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import { startAssetServer } from './asset-server';
import { RenderInputError } from './errors';
import { loadManifest, type RenderManifest } from './manifest';
import { loadRegistry, RENDER_ROOT, validateManifestAgainstRegistry } from './registry';
import { COMPOSITION_ID } from './Root';

// ---- stdout 隔离 ---------------------------------------------------------
const writeStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
  (process.stderr.write as (...args: never[]) => boolean)(
    chunk as never,
    ...(rest as never[]),
  )) as typeof process.stdout.write;

function emit(line: Record<string, unknown>): void {
  writeStdout(`${JSON.stringify(line)}\n`);
}
function logStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

// ---- 参数 ---------------------------------------------------------------
export type RenderProfile = 'preview' | 'final';
type Args = { manifest: string; out: string; registry?: string; profile: RenderProfile };

/**
 * 两档规格，**不开放散参数**（v2 spec §4.1）：散参数会让「预览」与「成片」的差异
 * 散落在调用方手里，迟早漂移成两种成片。manifest 尺寸恒为 1920×1080 契约，
 * preview 靠 `scale: 0.5` 输出 960×540。
 */
const PROFILES: Record<RenderProfile, { scale: number; x264Preset: 'veryfast' | 'medium'; crf: number }> = {
  preview: { scale: 0.5, x264Preset: 'veryfast', crf: 28 },
  final: { scale: 1, x264Preset: 'medium', crf: 18 },
};

const USAGE = [
  '用法：npm --prefix render run render -- --manifest <绝对路径> --out <绝对路径> [--registry <绝对路径>] [--profile preview|final]',
  '  --manifest  render-manifest JSON（spec §2.8 冻结点）',
  '  --out       成片输出路径（.mp4）',
  '  --registry  受控枚举清单，默认 render/../src/modules/video/timeline-registry.json',
  '  --profile   final（默认，全规格 1920×1080）｜preview（半尺寸 960×540 快出，门内看片用）',
].join('\n');

export function parseArgs(argv: readonly string[]): Args {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      values[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new RenderInputError(`参数 ${token} 缺少取值\n${USAGE}`);
      }
      values[token.slice(2)] = next;
      i++;
    }
  }

  const missing = (['manifest', 'out'] as const).filter((k) => !values[k]);
  if (missing.length > 0) {
    throw new RenderInputError(`缺少必填参数：${missing.map((m) => `--${m}`).join('、')}\n${USAGE}`);
  }
  for (const key of ['manifest', 'out', 'registry'] as const) {
    const value = values[key];
    if (value && !path.isAbsolute(value)) {
      throw new RenderInputError(`--${key} 必须是绝对路径，收到：${value}`);
    }
  }
  const profile = values.profile ?? 'final';
  if (profile !== 'preview' && profile !== 'final') {
    throw new RenderInputError(`--profile 只能是 preview / final，收到：${profile}\n${USAGE}`);
  }
  return { manifest: values.manifest!, out: values.out!, registry: values.registry, profile };
}

// ---- 素材 ---------------------------------------------------------------
function collectAssetPaths(manifest: RenderManifest): string[] {
  const paths = [manifest.anchorAudio.file, manifest.arollVideo.file];
  for (const overlay of manifest.overlays) {
    if (overlay.file) paths.push(overlay.file);
  }
  return paths;
}

function assertAssetsReadable(paths: readonly string[]): void {
  const problems: string[] = [];
  for (const file of paths) {
    if (!path.isAbsolute(file)) {
      problems.push(`  · 素材路径必须是绝对路径：${file}`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`  · 素材文件不存在：${file}`);
      continue;
    }
    if (statSync(file).size === 0) {
      problems.push(`  · 素材文件是空文件：${file}`);
    }
  }
  if (problems.length > 0) {
    throw new RenderInputError(`manifest 引用的素材有问题：\n${problems.join('\n')}`);
  }
}

/** 把 manifest 里的绝对路径换成本地素材服务的 http URL（Remotion 只认 http/https）。 */
function withServedAssets(manifest: RenderManifest, urlFor: (p: string) => string): RenderManifest {
  return {
    ...manifest,
    anchorAudio: { ...manifest.anchorAudio, file: urlFor(manifest.anchorAudio.file) },
    arollVideo: { ...manifest.arollVideo, file: urlFor(manifest.arollVideo.file) },
    overlays: manifest.overlays.map((overlay) =>
      overlay.file ? { ...overlay, file: urlFor(overlay.file) } : overlay,
    ),
  };
}

// ---- 主流程 -------------------------------------------------------------
const PROGRESS_THROTTLE_MS = 1000;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const manifest = loadManifest(args.manifest);
  const { path: registryPath, registry } = loadRegistry(args.registry);
  validateManifestAgainstRegistry(manifest, registry, registryPath);

  const assetPaths = collectAssetPaths(manifest);
  assertAssetsReadable(assetPaths);

  mkdirSync(path.dirname(args.out), { recursive: true });

  const assetServer = await startAssetServer(assetPaths);
  let bundleDir: string | null = null;

  try {
    await ensureBrowser({
      logLevel: 'error',
      onBrowserDownload: () => ({
        version: null,
        onProgress: ({ alreadyAvailable, percent }) => {
          if (alreadyAvailable) return;
          logStderr(`[render] 首次运行：下载 Chrome Headless Shell ${Math.round(percent * 100)}%`);
        },
      }),
    });

    logStderr('[render] 打包 Remotion bundle…');
    bundleDir = await bundle({
      entryPoint: path.join(RENDER_ROOT, 'src/index.ts'),
      publicDir: path.join(RENDER_ROOT, 'public'),
      onProgress: () => {
        /* webpack 进度不进 stdout；需要时看 stderr 的阶段日志即可 */
      },
    });

    const inputProps = { manifest: withServedAssets(manifest, assetServer.urlFor) };

    const composition = await selectComposition({
      serveUrl: bundleDir,
      id: COMPOSITION_ID,
      inputProps,
      logLevel: 'error',
    });

    const totalFrames = composition.durationInFrames;
    let lastEmitAt = Date.now();
    let lastRenderedFrames = 0;
    emit({ type: 'progress', renderedFrames: 0, totalFrames });

    const profile = PROFILES[args.profile];
    logStderr(`[render] profile=${args.profile}（scale ${profile.scale} / ${profile.x264Preset} / crf ${profile.crf}）`);

    await renderMedia({
      composition,
      serveUrl: bundleDir,
      codec: 'h264',
      audioCodec: 'aac',
      outputLocation: args.out,
      inputProps,
      scale: profile.scale,
      x264Preset: profile.x264Preset,
      crf: profile.crf,
      // null = 交给 Remotion 按机器核数自动选（spec §6.1：首跑 benchmark 后再写死）。
      concurrency: null,
      logLevel: 'error',
      overwrite: true,
      onProgress: ({ renderedFrames }) => {
        // 帧数没动就不重复播报（renderMedia 在编码/合流阶段还会持续回调）。
        if (renderedFrames === lastRenderedFrames) return;
        const now = Date.now();
        const isLastFrame = renderedFrames >= totalFrames;
        if (!isLastFrame && now - lastEmitAt < PROGRESS_THROTTLE_MS) return;
        lastEmitAt = now;
        lastRenderedFrames = renderedFrames;
        emit({ type: 'progress', renderedFrames, totalFrames });
      },
    });

    emit({ type: 'done', outFile: args.out });
  } finally {
    await assetServer.close();
    if (bundleDir) {
      try {
        rmSync(bundleDir, { recursive: true, force: true });
      } catch {
        // 临时 bundle 目录清不掉不影响成片，交给系统 tmp 回收。
      }
    }
  }
}

main().catch((err: unknown) => {
  // 输入不合法只打人话；真崩了才打栈（stderr 会被截断进 job，别让 node 内部栈盖住原因）。
  const message =
    err instanceof RenderInputError
      ? err.message
      : err instanceof Error
        ? (err.stack ?? err.message)
        : String(err);
  logStderr(`[render] 渲染失败：\n${message}`);
  process.exit(1);
});
