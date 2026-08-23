/**
 * 标题卡 hook-title（registry titles）。
 * 语义（spec §2.5）：**输出域开头的覆盖层**——不前插、不改成片时长。
 * 进场靠 useCurrentFrame 插值，无 CSS 动画。
 */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { captionFontStack, useLocalCaptionFont } from '../fonts';
import type { CaptionTheme } from '../manifest';

export const HookTitle: React.FC<{
  readonly text: string;
  readonly durationInFrames: number;
  readonly theme: CaptionTheme;
}> = ({ text, durationInFrames, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const localFamily = useLocalCaptionFont();
  // 字号跟画面高度走而不是写死像素：换画幅时标题卡不该跟着变大变小。
  const fontSize = Math.round(height * 0.096);

  const enterFrames = Math.max(1, Math.min(Math.round(fps * 0.4), Math.floor(durationInFrames / 2)));
  const opacity = interpolate(frame, [0, enterFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const rise = interpolate(frame, [0, enterFrames], [40, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        padding: Math.round(width * 0.08),
        background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.15) 50%, rgba(0,0,0,0.55) 100%)',
        opacity,
      }}
    >
      <div
        style={{
          transform: `translateY(${rise}px)`,
          fontFamily: captionFontStack(theme, localFamily),
          fontSize,
          fontWeight: 900,
          lineHeight: 1.2,
          color: theme.primaryColor,
          textAlign: 'center',
          textShadow: '0 8px 28px rgba(0,0,0,0.8)',
        }}
      >
        {text}
      </div>
      <div
        style={{
          marginTop: 36,
          width: 160,
          height: 10,
          borderRadius: 5,
          backgroundColor: theme.accentColor,
          opacity,
        }}
      />
    </AbsoluteFill>
  );
};
