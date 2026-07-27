/**
 * 屏录 B-roll：圆角设备框 + 裁剪播放。
 * inMs/outMs 是**源素材**内的裁剪区间；overlay 在输出域的位置由外层 Sequence 决定。
 */
import React from 'react';
import { AbsoluteFill, OffthreadVideo, useVideoConfig } from 'remotion';
import { msToFrames } from '../time';

export const ScreenRecClip: React.FC<{
  readonly file: string;
  readonly inMs?: number;
  readonly outMs?: number;
  readonly fit: 'cover' | 'contain';
}> = ({ file, inMs, outMs, fit }) => {
  const { fps, width, height } = useVideoConfig();
  const cardWidth = Math.round(width * 0.9);
  const cardHeight = Math.round(height * 0.42);

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        // 往上挪一点，给底部字幕安全区让位。
        paddingBottom: Math.round(height * 0.18),
      }}
    >
      <div
        style={{
          width: cardWidth,
          height: cardHeight,
          borderRadius: 36,
          overflow: 'hidden',
          backgroundColor: '#101216',
          boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
          border: '2px solid rgba(255,255,255,0.12)',
        }}
      >
        <OffthreadVideo
          src={file}
          muted
          trimBefore={inMs === undefined ? undefined : msToFrames(inMs, fps)}
          trimAfter={outMs === undefined ? undefined : msToFrames(outMs, fps)}
          style={{ width: '100%', height: '100%', objectFit: fit }}
        />
      </div>
    </AbsoluteFill>
  );
};
