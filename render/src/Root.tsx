/**
 * Remotion composition 登记。画幅/帧率/时长全部由 render-manifest 决定（calculateMetadata），
 * CLI 只负责把校验过的 manifest 作为 inputProps 塞进来。
 */
import React from 'react';
import { Composition } from 'remotion';
import type { RenderManifest } from './manifest';
import { VideoComposition, type VideoCompositionProps } from './components/VideoComposition';

export const COMPOSITION_ID = 'autocrew-video';

/** manifest 缺失时的占位画幅（V0a 竖屏 1080×1920@30）。 */
const FALLBACK = { width: 1080, height: 1920, fps: 30, durationInFrames: 30 } as const;

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id={COMPOSITION_ID}
      component={VideoComposition}
      width={FALLBACK.width}
      height={FALLBACK.height}
      fps={FALLBACK.fps}
      durationInFrames={FALLBACK.durationInFrames}
      defaultProps={{ manifest: null } as VideoCompositionProps}
      calculateMetadata={({ props }) => {
        const manifest = props.manifest as RenderManifest | null;
        if (!manifest) return FALLBACK;
        return {
          width: manifest.width,
          height: manifest.height,
          fps: manifest.fps,
          durationInFrames: Math.max(1, Math.round((manifest.durationMs / 1000) * manifest.fps)),
        };
      }}
    />
  );
};
