/**
 * best-effort 拉一份 Noto Sans SC 到 render/public/fonts/，给「换机器也要同样字形」的可移植路径用。
 *
 *   npm --prefix render run fetch-fonts
 *
 * **失败只警告不阻断**：V0a 默认路径是 macOS 系统字体（PingFang SC 等，headless Chrome 直接可用），
 * 本地字体只是加分项。下载源用 npmmirror（国内可达）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDER_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FONT_DIR = path.join(RENDER_ROOT, 'public/fonts');
const TIMEOUT_MS = 20_000;

/** 目标文件名 → 候选下载地址（按顺序试）。文件名与 src/fonts.ts 的候选列表对齐。 */
const TARGETS: { file: string; urls: string[] }[] = [
  {
    file: 'caption-bold.woff2',
    urls: [
      'https://registry.npmmirror.com/@fontsource/noto-sans-sc/latest/files/files/noto-sans-sc-chinese-simplified-700-normal.woff2',
      'https://registry.npmmirror.com/@fontsource/noto-sans-sc/5.0.18/files/files/noto-sans-sc-chinese-simplified-700-normal.woff2',
    ],
  },
  {
    file: 'caption-regular.woff2',
    urls: [
      'https://registry.npmmirror.com/@fontsource/noto-sans-sc/latest/files/files/noto-sans-sc-chinese-simplified-400-normal.woff2',
      'https://registry.npmmirror.com/@fontsource/noto-sans-sc/5.0.18/files/files/noto-sans-sc-chinese-simplified-400-normal.woff2',
    ],
  },
];

async function download(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 1024) throw new Error(`文件太小（${buf.byteLength} 字节），不像字体`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  mkdirSync(FONT_DIR, { recursive: true });
  let ok = 0;

  for (const target of TARGETS) {
    let saved = false;
    for (const url of target.urls) {
      try {
        const buf = await download(url);
        writeFileSync(path.join(FONT_DIR, target.file), buf);
        console.log(`✓ ${target.file}（${(buf.byteLength / 1024).toFixed(0)} KB）← ${url}`);
        saved = true;
        ok++;
        break;
      } catch (err) {
        console.warn(`  · 拉取失败：${url} —— ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!saved) console.warn(`⚠️  ${target.file} 没拉到，跳过`);
  }

  if (ok === 0) {
    console.warn(
      '⚠️  一个字体也没拉到（网络不通？）。不影响渲染：V0a 默认走 macOS 系统字体（identity.captionTheme.fontFamily）。',
    );
  } else {
    console.log(`完成：${ok}/${TARGETS.length} 个字体已放入 ${FONT_DIR}`);
  }
}

main().catch((err: unknown) => {
  // 字体是加分项，不该让任何调用方因此失败。
  console.warn(`⚠️  fetch-fonts 异常（忽略）：${err instanceof Error ? err.message : String(err)}`);
});
