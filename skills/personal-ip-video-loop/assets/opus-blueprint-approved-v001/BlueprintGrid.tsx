import React from 'react';
import { AbsoluteFill } from 'remotion';
import { GRID as G } from '../theme';

// 静态蓝图底：不随帧变化，因此没有颗粒闪烁或漂移
const GridPatterns: React.FC = () => (
  <>
    <pattern id="minor" width={G.minor} height={G.minor} patternUnits="userSpaceOnUse" y={G.majorOffsetY}>
      <rect width={1} height={G.minor} fill={G.line} opacity={G.minorOpacity} />
      <rect width={G.minor} height={1} fill={G.line} opacity={G.minorOpacity} />
    </pattern>
    <pattern id="major" width={G.major} height={G.major} patternUnits="userSpaceOnUse" y={G.majorOffsetY}>
      <rect x={-G.majorWidth / 2} width={G.majorWidth} height={G.major} fill={G.line} opacity={G.majorOpacity} />
      <rect y={-G.majorWidth / 2} width={G.major} height={G.majorWidth} fill={G.line} opacity={G.majorOpacity} />
      <rect x={G.major - G.majorWidth / 2} width={G.majorWidth} height={G.major} fill={G.line} opacity={G.majorOpacity} />
      <rect y={G.major - G.majorWidth / 2} width={G.major} height={G.majorWidth} fill={G.line} opacity={G.majorOpacity} />
    </pattern>
  </>
);

const Gradients: React.FC = () => (
  <>
    <radialGradient id="base" cx={G.bgCenterAt.x} cy={G.bgCenterAt.y} r={G.bgRadius} gradientUnits="userSpaceOnUse">
      <stop offset="0" stopColor={G.bgCenter} />
      <stop offset="1" stopColor={G.bgEdge} />
    </radialGradient>
    {/* 阅读池：画面中部网格减弱，前景更好读 */}
    <radialGradient id="pool" cx={960} cy={500} r={760} gradientUnits="userSpaceOnUse">
      <stop offset="0" stopColor="#fff" stopOpacity={G.readingPoolCenterOpacity} />
      <stop offset="1" stopColor="#fff" stopOpacity={1} />
    </radialGradient>
    <mask id="poolMask">
      <rect width={G.width} height={G.height} fill="url(#pool)" />
    </mask>
    <radialGradient id="vignette" cx={960} cy={520} r={1150} gradientUnits="userSpaceOnUse">
      <stop offset="0.55" stopColor="#081428" stopOpacity={0} />
      <stop offset="1" stopColor="#081428" stopOpacity={G.vignetteOpacity} />
    </radialGradient>
    <linearGradient id="captionBand" x1={0} y1={G.captionBandTop} x2={0} y2={G.height} gradientUnits="userSpaceOnUse">
      <stop offset="0" stopColor={G.captionBandColor} stopOpacity={0} />
      <stop offset="1" stopColor={G.captionBandColor} stopOpacity={G.captionBandOpacity} />
    </linearGradient>
  </>
);

// 纸面材质：低频斑驳 + 极细颗粒，固定种子
const PaperFilters: React.FC = () => (
  <>
    <filter id="mottle" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.0035" numOctaves={3} seed={11} />
      <feColorMatrix type="matrix" values={`0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${G.mottleOpacity * 2} ${-G.mottleOpacity * 0.6}`} />
    </filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={7} stitchTiles="stitch" />
      <feColorMatrix type="saturate" values="0" />
      <feComponentTransfer>
        <feFuncA type="table" tableValues={`0 ${G.grainOpacity}`} />
      </feComponentTransfer>
    </filter>
  </>
);

export const BlueprintGrid: React.FC = () => (
  <AbsoluteFill>
    <svg width={G.width} height={G.height} viewBox={`0 0 ${G.width} ${G.height}`}>
      <defs>
        <GridPatterns />
        <Gradients />
        <PaperFilters />
      </defs>
      <rect width={G.width} height={G.height} fill="url(#base)" />
      <rect width={G.width} height={G.height} filter="url(#mottle)" />
      <g mask="url(#poolMask)">
        <rect width={G.width} height={G.height} fill="url(#minor)" />
        <rect width={G.width} height={G.height} fill="url(#major)" />
      </g>
      <rect width={G.width} height={G.height} filter="url(#grain)" />
      <rect width={G.width} height={G.height} fill="url(#vignette)" />
      <rect width={G.width} height={G.height} fill="url(#captionBand)" />
    </svg>
  </AbsoluteFill>
);
