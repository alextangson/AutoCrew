/**
 * 逐词高亮字幕（registry caption style: word-highlight）。
 *
 * 输入的 words 已被上游投影到**输出时间域**（spec §2.4），渲染层不再做时间映射。
 * 高亮规则：当前时刻命中的词用 emphasisColor；emphasisWords 命中的词恒用 emphasisColor
 * （归一化 + 跨词短语匹配，见 emphasis.ts）。
 *
 * 横屏版式（横屏 spec §2.2）：按像素估宽断行、字号随文本宽度自适应、底部安全区 15%、
 * 整屏屏录之上垫半透明底板、标题卡在场时段整体隐藏。
 */
import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { markEmphasis } from '../emphasis';
import { captionFontStack, useLocalCaptionFont } from '../fonts';
import type { CaptionTheme, CaptionWord } from '../manifest';
import {
  CAPTION_BOTTOM_SAFE_RATIO,
  captionFontSize,
  captionLayout,
  framesToMs,
  groupWordsIntoLines,
  spansContain,
  type TimeSpan,
} from '../time';

export { CAPTION_BOTTOM_SAFE_RATIO };

export const WordHighlightCaptions: React.FC<{
  readonly words: readonly CaptionWord[];
  readonly emphasisWords: readonly string[];
  readonly theme: CaptionTheme;
  readonly durationMs: number;
  /** 标题卡在场的时段（0 = 无标题卡）；层级冲突显式化，两者不叠。 */
  readonly hideUntilMs?: number;
  /** 需要垫底板的时段（整屏屏录/图版）。 */
  readonly backdropSpans?: readonly TimeSpan[];
}> = ({ words, emphasisWords, theme, durationMs, hideUntilMs = 0, backdropSpans = [] }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const localFamily = useLocalCaptionFont();

  const layout = useMemo(() => captionLayout(width, height), [width, height]);
  const lines = useMemo(
    () => groupWordsIntoLines([...words], { totalDurationMs: durationMs, maxWidthEm: layout.maxWidthEm }),
    [words, durationMs, layout.maxWidthEm],
  );

  const nowMs = framesToMs(frame, fps);
  const line = nowMs < hideUntilMs ? undefined : lines.find((l) => nowMs >= l.showFromMs && nowMs < l.showUntilMs);
  const emphasis = useMemo(() => markEmphasis(line?.words ?? [], emphasisWords), [line, emphasisWords]);
  if (!line) return null;

  const fontSize = captionFontSize(line.widthEm, layout);
  const onOverlay = spansContain(backdropSpans, nowMs);

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingBottom: Math.round(height * CAPTION_BOTTOM_SAFE_RATIO),
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'baseline',
          gap: '0 6px',
          maxWidth: Math.round(layout.rowWidthPx),
          fontFamily: captionFontStack(theme, localFamily),
          fontSize,
          fontWeight: 800,
          lineHeight: 1.25,
          textAlign: 'center',
          textShadow: '0 4px 18px rgba(0,0,0,0.75), 0 0 2px rgba(0,0,0,0.9)',
          // 白色界面的屏录上描边扛不住，改用底板（spec §2.2）
          ...(onOverlay
            ? {
                backgroundColor: 'rgba(0,0,0,0.62)',
                borderRadius: Math.round(fontSize * 0.25),
                padding: `${Math.round(fontSize * 0.18)}px ${Math.round(fontSize * 0.4)}px`,
              }
            : {}),
        }}
      >
        {line.words.map((word, index) => {
          const isCurrent = nowMs >= word.startMs && nowMs < word.endMs;
          const color = isCurrent || emphasis[index] ? theme.emphasisColor : theme.primaryColor;
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
