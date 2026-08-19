/**
 * 选区改写浮动工具条：锚定在选区末行下方，贴底时翻到选区上方，滚动/缩放时重算；
 * 测量失败降级为编辑区下方的静态条。指令输入放组件内部——条随选区消失而卸载。
 *
 * 两种宿主都要支持：CodeMirror（正常态，coordsAtPos 直接给坐标）和
 * textarea（CodeMirror 挂载失败的降级态，用 caret.ts 镜像测量）。
 */
import { useLayoutEffect, useRef, useState } from "react";
import { type EditorView } from "@codemirror/view";
import { measureCaret } from "../caret";

interface Anchor {
  /** 相对宿主左上角的坐标 */
  top: number;
  left: number;
  height: number;
}

function measureInView(view: EditorView, pos: number): { anchor: Anchor; width: number; height: number } | null {
  const coords = view.coordsAtPos(pos);
  if (!coords) return null;
  const box = view.dom.getBoundingClientRect();
  return {
    anchor: { top: coords.top - box.top, left: coords.left - box.left, height: coords.bottom - coords.top },
    width: box.width,
    height: box.height,
  };
}

function measureInTextarea(ta: HTMLTextAreaElement, pos: number): { anchor: Anchor; width: number; height: number } | null {
  const caret = measureCaret(ta, pos);
  if (!caret) return null;
  return {
    anchor: { top: caret.top, left: caret.left, height: caret.height },
    width: ta.clientWidth,
    height: ta.clientHeight,
  };
}

export function SelectionBar(props: {
  view: EditorView | null;
  ta: HTMLTextAreaElement | null;
  sel: { start: number; end: number };
  onFocus: () => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  const place = () => {
    const measure = (at: number) =>
      props.view ? measureInView(props.view, at) : props.ta ? measureInTextarea(props.ta, at) : null;
    const end = measure(props.sel.end);
    if (!end) return setPos(null);
    const barW = barRef.current?.offsetWidth ?? 520;
    const barH = barRef.current?.offsetHeight ?? 44;
    let top = end.anchor.top + end.anchor.height + 8;
    if (top + barH > end.height - 4) {
      const start = measure(props.sel.start);
      top = (start ?? end).anchor.top - barH - 8;
    }
    top = Math.max(4, Math.min(top, Math.max(4, end.height - barH - 4)));
    const left = Math.max(4, Math.min(end.anchor.left - 24, Math.max(4, end.width - barW - 4)));
    setPos({ top, left });
  };

  useLayoutEffect(() => {
    place();
    const scroller = props.view?.scrollDOM ?? props.ta;
    const onMove = () => place();
    scroller?.addEventListener("scroll", onMove);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      scroller?.removeEventListener("scroll", onMove);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sel.start, props.sel.end, props.view, props.ta]);

  return (
    <div
      ref={barRef}
      className={pos ? "sel-bar sel-float" : "sel-bar"}
      style={pos ? { top: pos.top, left: pos.left } : undefined}
    >
      <span className="mono muted">选中 {props.sel.end - props.sel.start} 字</span>
      <button className="primary" onClick={props.onFocus}>改这段 →</button>
      <span className="muted">锁定这段,去总编辑说怎么改</span>
    </div>
  );
}
