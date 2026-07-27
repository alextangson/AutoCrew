/**
 * 字幕字体解析。
 *
 * V0a 默认路径 = **macOS 系统字体**：headless Chrome 直接吃系统已装字体，
 * 所以 identity.captionTheme.fontFamily 里写 "PingFang SC" 这类系统字体名即可生效，
 * 无需任何下载/打包步骤。
 *
 * 可移植路径（换机器/换 CI 也要一模一样的字形）：把字体文件放进 render/public/fonts/，
 * 本模块会优先加载它（`npm --prefix render run fetch-fonts` 可 best-effort 拉一份 Noto Sans SC）。
 * 本地字体加载失败 = 静默回落到系统字体，不阻断渲染——字体缺失不该让成片渲不出来。
 */
import { useEffect, useState } from 'react';
import { continueRender, delayRender, getStaticFiles, staticFile } from 'remotion';
import type { CaptionTheme } from './manifest';

/** 本地字体注册后的 family 名，与系统字体名刻意区分开。 */
export const LOCAL_CAPTION_FAMILY = 'AutocrewCaption';

/** public/fonts/ 下按顺序探测的候选文件（fetch-fonts.mts 写入的就是前两个）。 */
export const LOCAL_CAPTION_FONT_CANDIDATES = [
  'fonts/caption-bold.woff2',
  'fonts/caption-regular.woff2',
  'fonts/caption.woff2',
  'fonts/caption.otf',
  'fonts/caption.ttf',
];

/** macOS 优先的中文字体兜底栈。 */
const SYSTEM_FALLBACK_STACK = [
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Heiti SC"',
  '"Noto Sans CJK SC"',
  '"Microsoft YaHei"',
  'system-ui',
  'sans-serif',
];

const MONO_FALLBACK_STACK = [
  '"SF Mono"',
  '"JetBrains Mono"',
  'Menlo',
  'Monaco',
  '"Courier New"',
  'monospace',
];

function quoteFamily(family: string): string {
  const trimmed = family.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
  return /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
}

/** 拼 CSS font-family 栈：本地字体 > identity 指定字体 > 系统兜底。 */
export function captionFontStack(theme: CaptionTheme, localFamily: string | null): string {
  const stack: string[] = [];
  if (localFamily) stack.push(quoteFamily(localFamily));
  if (theme.fontFamily) stack.push(quoteFamily(theme.fontFamily));
  stack.push(...SYSTEM_FALLBACK_STACK);
  return stack.join(', ');
}

/** 代码块等宽字体栈。 */
export function monoFontStack(fontFamily?: string): string {
  const stack: string[] = [];
  if (fontFamily) stack.push(quoteFamily(fontFamily));
  stack.push(...MONO_FALLBACK_STACK);
  return stack.join(', ');
}

/** 从 bundle 的静态文件清单里挑第一个命中的候选字体（不发请求，所以不会刷 404）。 */
export function pickLocalFontFile(): string | null {
  const available = new Set(getStaticFiles().map((f) => f.name));
  return LOCAL_CAPTION_FONT_CANDIDATES.find((candidate) => available.has(candidate)) ?? null;
}

/**
 * 探测并加载 public/fonts/ 下的本地字体。返回 family 名或 null（没有本地字体）。
 * 用 delayRender 保证第一帧渲染前字体已就位——否则会渲出「第一帧字体不对」的抖动。
 */
export function useLocalCaptionFont(): string | null {
  const [candidate] = useState(() => pickLocalFontFile());
  const [handle] = useState(() =>
    candidate === null ? null : delayRender(`加载本地字幕字体 ${candidate}`),
  );
  const [family, setFamily] = useState<string | null>(null);

  useEffect(() => {
    if (candidate === null || handle === null) return;
    let cancelled = false;
    const load = async () => {
      try {
        const face = new FontFace(LOCAL_CAPTION_FAMILY, `url(${staticFile(candidate)})`);
        await face.load();
        document.fonts.add(face);
        if (!cancelled) setFamily(LOCAL_CAPTION_FAMILY);
      } catch (err) {
        // 本地字体坏了不该让成片渲不出来——回落系统字体，但把原因喊出来（stderr 进 job log）。
        console.warn(`[render] 本地字幕字体加载失败，回落系统字体：${candidate}`, err);
      }
    };
    load().finally(() => continueRender(handle));
    return () => {
      cancelled = true;
    };
  }, [candidate, handle]);

  return family;
}
