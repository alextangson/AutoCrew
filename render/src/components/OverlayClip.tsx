/**
 * 覆盖轨：盖在 A-roll 底轨之上，主音轨/字幕不受影响（spec §2.5，z-order base < overlay < captions）。
 *
 * 转场：`fade` = 入出各 300ms 的 opacity 插值（useCurrentFrame 插值，禁 CSS animation / Math.random）；
 * `cut` = 无过渡。未知 kind/template 一律抛错——全链无静默降级（spec §10-5）。
 */
import React from 'react';
import { AbsoluteFill, Img, interpolate, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CodeTheme, Overlay } from '../manifest';
import { defaultFit } from '../overlay';
import { fadeRanges, msToDurationFrames, msToFrames } from '../time';
import { CodeBlock } from './CodeBlock';
import { ScreenRecClip } from './ScreenRecClip';

/** fade 转场的单侧时长。 */
export const FADE_MS = 300;

function requireString(props: Record<string, unknown> | undefined, key: string, clipId: string): string {
  const value = props?.[key];
  if (typeof value !== 'string') {
    throw new Error(`overlay ${clipId} 的 props.${key} 必须是字符串，实际是 ${typeof value}`);
  }
  return value;
}

const OverlayBody: React.FC<{
  readonly overlay: Overlay;
  readonly durationInFrames: number;
  readonly codeTheme?: CodeTheme;
}> = ({ overlay, durationInFrames, codeTheme }) => {
  const { fps } = useVideoConfig();
  const fit = overlay.fit ?? defaultFit(overlay.kind);

  switch (overlay.kind) {
    case 'screen':
      return (
        <ScreenRecClip file={overlay.file!} inMs={overlay.inMs} outMs={overlay.outMs} fit={fit} />
      );
    case 'ai':
      return (
        <AbsoluteFill>
          <OffthreadVideo
            src={overlay.file!}
            muted
            trimBefore={overlay.inMs === undefined ? undefined : msToFrames(overlay.inMs, fps)}
            trimAfter={overlay.outMs === undefined ? undefined : msToFrames(overlay.outMs, fps)}
            style={{ width: '100%', height: '100%', objectFit: fit }}
          />
        </AbsoluteFill>
      );
    case 'image':
      return (
        <AbsoluteFill style={{ backgroundColor: '#000000' }}>
          <Img src={overlay.file!} style={{ width: '100%', height: '100%', objectFit: fit }} />
        </AbsoluteFill>
      );
    case 'graphic': {
      if (overlay.template === 'code-block') {
        return (
          <CodeBlock
            code={requireString(overlay.props, 'code', overlay.clipId)}
            lang={requireString(overlay.props, 'lang', overlay.clipId)}
            durationInFrames={durationInFrames}
            theme={codeTheme}
          />
        );
      }
      throw new Error(
        `overlay ${overlay.clipId} 用了渲染层未实现的 graphic 模板「${overlay.template}」——` +
          `新模板必须先进 timeline-registry.json 并在 render/src/components 实现`,
      );
    }
    default: {
      const exhaustive: never = overlay.kind;
      throw new Error(`overlay ${overlay.clipId} 的 kind 不认识：${String(exhaustive)}`);
    }
  }
};

const FadeWrapper: React.FC<{
  readonly transition: string | undefined;
  readonly durationInFrames: number;
  readonly children: React.ReactNode;
}> = ({ transition, durationInFrames, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ranges = transition === 'fade' ? fadeRanges(durationInFrames, msToFrames(FADE_MS, fps)) : null;
  const opacity = ranges
    ? interpolate(frame, ranges.input, ranges.output, {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

export const OverlayClip: React.FC<{
  readonly overlay: Overlay;
  readonly fps: number;
  readonly codeTheme?: CodeTheme;
}> = ({ overlay, fps, codeTheme }) => {
  const durationInFrames = msToDurationFrames(overlay.durationMs, fps);
  return (
    <Sequence
      from={msToFrames(overlay.outputStartMs, fps)}
      durationInFrames={durationInFrames}
      name={`overlay ${overlay.clipId}`}
      layout="none"
    >
      <FadeWrapper transition={overlay.transition} durationInFrames={durationInFrames}>
        <OverlayBody overlay={overlay} durationInFrames={durationInFrames} codeTheme={codeTheme} />
      </FadeWrapper>
    </Sequence>
  );
};
