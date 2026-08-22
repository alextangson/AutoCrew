/**
 * 覆盖轨的纯决策（横屏 spec §2.5）。
 * 单独成文件是为了能被测：组件在 .tsx 里带 remotion 运行时，规则本身不该跟着一起被拖进来。
 */
import type { Overlay } from './manifest';

/**
 * fit 默认值：screen/image 默认 `contain`——屏录与自制图版都是「有字的画面」，
 * 裁掉半行字比留黑边糟得多。ai 类是生成的镜头，裁边不丢信息，维持 `cover` 铺满。
 * manifest 里显式写了 fit 就以显式为准（agent 可以按素材主动要 cover）。
 */
export function defaultFit(kind: Overlay['kind']): 'cover' | 'contain' {
  return kind === 'ai' ? 'cover' : 'contain';
}
