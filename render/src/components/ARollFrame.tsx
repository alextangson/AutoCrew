/**
 * 底轨：真人出镜 A-roll。
 *
 * 按 outputMap（manifest.arollVideo.segments）把源视频切段拼到输出域：
 * 每段一个 Sequence（起点=outputStartMs），内嵌 OffthreadVideo 用 trimBefore/trimAfter 裁源。
 * **恒 muted**——成片唯一音轨是 anchorAudio（spec §2.4：主音轨 = keep 段音频拼接 + loudnorm，
 * 由上游 ffmpeg 产出，渲染层不再从画面里取声）。
 */
import React from 'react';
import { AbsoluteFill, OffthreadVideo, Sequence } from 'remotion';
import type { ARollSegment } from '../manifest';
import { msToDurationFrames, msToFrames } from '../time';

export const ARollFrame: React.FC<{
  readonly file: string;
  readonly segments: readonly ARollSegment[];
  readonly fps: number;
}> = ({ file, segments, fps }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      {segments.map((seg, index) => {
        const from = msToFrames(seg.outputStartMs, fps);
        const durationInFrames = msToDurationFrames(seg.sourceEndMs - seg.sourceStartMs, fps);
        return (
          <Sequence
            key={`aroll-${index}-${seg.outputStartMs}`}
            from={from}
            durationInFrames={durationInFrames}
            name={`A-roll ${index + 1}`}
            layout="none"
          >
            <AbsoluteFill>
              <OffthreadVideo
                src={file}
                trimBefore={msToFrames(seg.sourceStartMs, fps)}
                trimAfter={msToFrames(seg.sourceEndMs, fps)}
                muted
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
