// 三色分工：冰青 = AI，暖米 = 人，朱红 = 责任/招牌（只在"找谁、招牌"时刻出现）
export const C = {
  cream: '#F3ECDF',
  cyan: '#8FD0F2',
  red: '#E5533D',
  ink: '#10233F',
  charcoal: '#2E2F33',
  warmWhite: '#EFE7DA',
} as const;

export const FONT = 'XinQingNian, "PingFang SC", sans-serif';

// 钴蓝细网格。主网格交点对齐画面中心 (960, 540)，墙体沿主网格绘制。
export const GRID = {
  width: 1920,
  height: 1080,
  bgCenter: '#2A62A0',
  bgEdge: '#1B477D',
  bgCenterAt: { x: 960, y: 470 },
  bgRadius: 1100,
  line: '#E6EEF8',
  minor: 30,
  minorOpacity: 0.05,
  major: 120,
  majorOffsetY: 60,
  majorWidth: 2,
  majorOpacity: 0.085,
  readingPoolCenterOpacity: 0.6,
  grainOpacity: 0.022,
  mottleOpacity: 0.035,
  vignetteOpacity: 0.26,
  captionBandTop: 820,
  captionBandColor: '#14365F',
  captionBandOpacity: 0.5,
} as const;

// 解释元素不得进入口播字幕区
export const SAFE = { left: 96, right: 1824, top: 90, bottom: 830 } as const;
