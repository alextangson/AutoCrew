/**
 * 屏录 B-roll：**整屏切换**（横屏 spec §2.5）。
 *
 * 上一版是 90%×42% 的圆角设备卡片——那是竖屏时代给「手机里放个视频」用的构图。
 * 横屏成片的验收基准是创始人手剪的那条：B-roll 直接盖满画面，不套壳、不留边框。
 * 装不满就留黑边（fit=contain 是默认），黑边好过把演示界面的字裁掉。
 *
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
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      <OffthreadVideo
        src={file}
        muted
        trimBefore={inMs === undefined ? undefined : msToFrames(inMs, fps)}
        trimAfter={outMs === undefined ? undefined : msToFrames(outMs, fps)}
        style={{ width: '100%', height: '100%', objectFit: fit }}
      />
    </AbsoluteFill>
  );
};
