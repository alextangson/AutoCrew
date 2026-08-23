/**
 * 整块字幕（registry caption style: plain）。
 *
 * 输入的 cues 已由 assemble 断好句并投影到**输出时间域**（v2 spec §2.1），
 * 渲染层不再做时间映射，也不再做断句——只负责「这一块怎么放得下」。
 *
 * 创始人裁决（v2 spec §0）：不要逐词黄色强调特效，阴影 + 脱底即可。所以：
 * 全词一个颜色、无逐词变色、无 scale 动画、**底板常开**（手剪基准就是黑底板白字）。
 * 显示窗恒等于 cue 的 [startMs, endMs)——**无 linger**，块与块之间不留残影。
 */
import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { captionFontStack, useLocalCaptionFont } from '../fonts';
import type { CaptionCue, CaptionTheme } from '../manifest';
import { CAPTION_BOTTOM_SAFE_RATIO, captionLayout, fitCue, framesToMs } from '../time';

export { CAPTION_BOTTOM_SAFE_RATIO };

export const Captions: React.FC<{
  readonly cues: readonly CaptionCue[];
  readonly theme: CaptionTheme;
  /** 标题卡在场的时段（0 = 无标题卡）；层级冲突显式化，两者不叠。 */
  readonly hideUntilMs?: number;
}> = ({ cues, theme, hideUntilMs = 0 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const localFamily = useLocalCaptionFont();

  const layout = useMemo(() => captionLayout(width, height), [width, height]);
  const nowMs = framesToMs(frame, fps);
  const cue = nowMs < hideUntilMs ? undefined : cues.find((c) => nowMs >= c.startMs && nowMs < c.endMs);
  const fitted = useMemo(() => (cue ? fitCue(cue.words, layout) : null), [cue, layout]);
  if (!cue || !fitted || fitted.lines.length === 0) return null;

  const { fontSize, lines } = fitted;
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
          maxWidth: Math.round(layout.rowWidthPx),
          fontFamily: captionFontStack(theme, localFamily),
          fontSize,
          fontWeight: 800,
          lineHeight: 1.25,
          textAlign: 'center',
          color: theme.primaryColor,
          textShadow: '0 4px 18px rgba(0,0,0,0.75), 0 0 2px rgba(0,0,0,0.9)',
          // 底板常开：白色界面的屏录上描边扛不住，而创始人手剪基准本来就是黑底板白字
          backgroundColor: 'rgba(0,0,0,0.62)',
          borderRadius: Math.round(fontSize * 0.25),
          padding: `${Math.round(fontSize * 0.18)}px ${Math.round(fontSize * 0.4)}px`,
        }}
      >
        {lines.map((line, row) => (
          <div key={`${cue.cueId}-${String(row)}`} style={{ whiteSpace: 'nowrap' }}>
            {line.map((word) => word.w).join('')}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
