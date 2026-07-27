/**
 * 逐词高亮字幕（registry caption style: word-highlight）。
 *
 * 输入的 words 已被上游投影到**输出时间域**（spec §2.4），渲染层不再做时间映射。
 * 高亮规则：当前时刻命中的词用 emphasisColor；emphasisWords 命中的词恒用 emphasisColor。
 * 版式：底部安全区留画面高度 15%，最多 10 字/行或 2.5 秒/行。
 */
import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { captionFontStack, useLocalCaptionFont } from '../fonts';
import type { CaptionTheme, CaptionWord } from '../manifest';
import { framesToMs, groupWordsIntoLines } from '../time';

/** 下沿安全区：画面高度的 15%。 */
export const CAPTION_BOTTOM_SAFE_RATIO = 0.15;

export const WordHighlightCaptions: React.FC<{
  readonly words: readonly CaptionWord[];
  readonly emphasisWords: readonly string[];
  readonly theme: CaptionTheme;
  readonly durationMs: number;
}> = ({ words, emphasisWords, theme, durationMs }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const localFamily = useLocalCaptionFont();

  const lines = useMemo(
    () => groupWordsIntoLines([...words], { totalDurationMs: durationMs }),
    [words, durationMs],
  );
  const emphasisSet = useMemo(
    () => new Set(emphasisWords.map((w) => w.trim()).filter((w) => w.length > 0)),
    [emphasisWords],
  );

  const nowMs = framesToMs(frame, fps);
  const line = lines.find((l) => nowMs >= l.showFromMs && nowMs < l.showUntilMs);
  if (!line) return null;

  const fontFamily = captionFontStack(theme, localFamily);

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingBottom: Math.round(height * CAPTION_BOTTOM_SAFE_RATIO),
        paddingLeft: 72,
        paddingRight: 72,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'baseline',
          gap: '0 6px',
          fontFamily,
          fontSize: 76,
          fontWeight: 800,
          lineHeight: 1.25,
          textAlign: 'center',
          textShadow: '0 4px 18px rgba(0,0,0,0.75), 0 0 2px rgba(0,0,0,0.9)',
        }}
      >
        {line.words.map((word, index) => {
          const isCurrent = nowMs >= word.startMs && nowMs < word.endMs;
          const isEmphasis = emphasisSet.has(word.w.trim());
          const color = isCurrent || isEmphasis ? theme.emphasisColor : theme.primaryColor;
          return (
            <span
              key={`${word.startMs}-${index}`}
              style={{
                color,
                // 当前词轻微放大，靠帧计算而非 CSS 动画——保证逐帧确定性。
                transform: isCurrent ? 'scale(1.06)' : 'scale(1)',
                display: 'inline-block',
              }}
            >
              {word.w}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
