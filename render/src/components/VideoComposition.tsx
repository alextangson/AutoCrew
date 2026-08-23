/**
 * 成片合成根组件。层序固定（spec §2.5）：底轨 A-roll < 覆盖轨 overlays < 标题卡 < 字幕。
 * 音轨只有一条：anchorAudio（A-roll 画面恒 muted）。
 */
import React from 'react';
import { AbsoluteFill, Audio, Sequence } from 'remotion';
import type { RenderManifest } from '../manifest';
import { msToDurationFrames } from '../time';
import { ARollFrame } from './ARollFrame';
import { Captions } from './Captions';
import { HookTitle } from './HookTitle';
import { OverlayClip } from './OverlayClip';

export type VideoCompositionProps = {
  manifest: RenderManifest | null;
};

/** Studio 里没传 manifest 时的占位——渲染链路永远走真 manifest。 */
const MissingManifest: React.FC = () => (
  <AbsoluteFill
    style={{
      backgroundColor: '#111318',
      color: '#f0f0f0',
      justifyContent: 'center',
      alignItems: 'center',
      fontSize: 48,
      textAlign: 'center',
      padding: 80,
    }}
  >
    未传入 render-manifest（请用 npm --prefix render run render -- --manifest ... --out ...）
  </AbsoluteFill>
);

export const VideoComposition: React.FC<VideoCompositionProps> = ({ manifest }) => {
  if (!manifest) return <MissingManifest />;

  const { fps } = manifest;
  const titleCard = manifest.titleCard;

  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      <ARollFrame file={manifest.arollVideo.file} segments={manifest.arollVideo.segments} fps={fps} />

      <Audio src={manifest.anchorAudio.file} />

      {manifest.overlays.map((overlay) => (
        <OverlayClip
          key={overlay.clipId}
          overlay={overlay}
          fps={fps}
          codeTheme={manifest.identity.codeTheme}
        />
      ))}

      {titleCard ? (
        <Sequence
          from={0}
          durationInFrames={msToDurationFrames(titleCard.durationMs, fps)}
          name="titleCard"
          layout="none"
        >
          <HookTitle
            text={titleCard.text}
            durationInFrames={msToDurationFrames(titleCard.durationMs, fps)}
            theme={manifest.identity.captionTheme}
          />
        </Sequence>
      ) : null}

      <Captions
        cues={manifest.captions.cues}
        theme={manifest.identity.captionTheme}
        // 标题卡在场时字幕整体让位；底板常开，不再按时段开关（v2 spec §2.2）
        hideUntilMs={titleCard ? titleCard.durationMs : 0}
      />
    </AbsoluteFill>
  );
};
