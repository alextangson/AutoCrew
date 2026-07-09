/**
 * textarea 选区像素坐标测量（镜像 div 技术）：浏览器不给 textarea 的 Range API，
 * 用同字体/同宽度的隐藏 div 复刻文本到目标索引，读末尾 span 的偏移得坐标。
 * 返回相对 textarea 可视区左上角的坐标（已扣除滚动）；测量失败返回 null，调用方降级。
 */

const MIRROR_STYLE_PROPS = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "textIndent",
  "textTransform",
] as const;

export interface CaretPos {
  /** 相对 textarea 可视区顶部 */
  top: number;
  /** 相对 textarea 可视区左侧 */
  left: number;
  /** 该行行高（浮层放行下方时用） */
  height: number;
}

export function measureCaret(ta: HTMLTextAreaElement, index: number): CaretPos | null {
  try {
    const computed = window.getComputedStyle(ta);
    const div = document.createElement("div");
    const mirror = div.style as unknown as Record<string, string>;
    const source = computed as unknown as Record<string, string>;
    for (const p of MIRROR_STYLE_PROPS) mirror[p] = source[p];
    div.style.position = "absolute";
    div.style.top = "-9999px";
    div.style.left = "0";
    div.style.visibility = "hidden";
    div.style.whiteSpace = "pre-wrap";
    div.style.overflowWrap = "break-word";
    div.style.border = "0";
    div.style.boxSizing = "border-box";
    // clientWidth = 内容 + padding（不含边框/滚动条），配合 border-box 复刻换行宽度
    div.style.width = `${ta.clientWidth}px`;
    div.textContent = ta.value.slice(0, index);
    const marker = document.createElement("span");
    marker.textContent = ta.value.slice(index, index + 1) || "​";
    div.appendChild(marker);
    document.body.appendChild(div);
    const pos = {
      top: marker.offsetTop - ta.scrollTop,
      left: marker.offsetLeft - ta.scrollLeft,
      height: marker.offsetHeight || parseFloat(computed.lineHeight) || 20,
    };
    div.remove();
    return pos;
  } catch {
    return null;
  }
}
