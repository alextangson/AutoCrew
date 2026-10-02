/** 测试夹具：合成正文（仓库公开，绝不放真实稿件文本） */

/** 确定性的合成中文：同一 seed 同一串，不同 seed 几乎不共享二元组 */
export function synth(seed: number, n: number): string {
  let x = seed * 7919 + 17;
  let out = "";
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += String.fromCharCode(0x4e00 + (x % 2000));
  }
  return out;
}
